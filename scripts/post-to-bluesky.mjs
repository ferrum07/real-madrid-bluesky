/**
 * Publica en Bluesky las publicaciones nuevas de @realmadrid en X.
 *
 * Por que no usamos joschi/blueskyfeedbot:
 * esa accion descarga el RSS con el fetch interno de Node (undici), y las
 * instancias de Nitter le devuelven un cuerpo vacio porque filtran por huella
 * TLS del cliente. curl si atraviesa ese filtro, asi que la descarga se hace
 * con curl y el resto del trabajo aqui.
 *
 * Deduplicado: por ID numerico del tweet, no por URL. Asi se puede cambiar de
 * instancia de Nitter sin que el bot crea que todo es nuevo y publique de golpe.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { XMLParser } from 'fast-xml-parser';
import { AtpAgent, RichText } from '@atproto/api';

const execFileAsync = promisify(execFile);

// --- Configuracion -------------------------------------------------------

const CUENTA = 'realmadrid';

// Se prueban en orden hasta que una devuelva un feed valido.
const FUENTES = (process.env.FEEDS?.split(',').map(s => s.trim()).filter(Boolean)) ?? [
  `https://nitter.net/${CUENTA}/rss`,
  `https://nitter.privacyredirect.com/${CUENTA}/rss`,
  `https://nitter.tiekoetter.com/${CUENTA}/rss`,
  `https://nitter.space/${CUENTA}/rss`,
  `https://lightbrd.com/${CUENTA}/rss`
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const CACHE_FILE = process.env.CACHE_FILE ?? 'cache/vistos.json';
const MAX_POR_EJECUCION = Number(process.env.MAX_POSTS_PER_RUN ?? 5);
const LIMITE_CACHE = 400;
const DRY_RUN = process.env.DRY_RUN === 'true';
const SALTAR_RETWEETS = process.env.SKIP_RETWEETS !== 'false';
const LIMITE_GRAFEMAS = 300;

// --- Descarga ------------------------------------------------------------

async function descargarFeed() {
  const fallos = [];

  for (const url of FUENTES) {
    try {
      const { stdout } = await execFileAsync('curl', [
        '--silent', '--location', '--max-time', '30',
        '--user-agent', UA,
        '--header', 'Accept: application/rss+xml, application/xml, text/xml, */*',
        url
      ], { maxBuffer: 20 * 1024 * 1024 });

      if (stdout.includes('<rss') || stdout.includes('<feed')) {
        console.log(`Fuente OK: ${url} (${stdout.length} bytes)`);
        return stdout;
      }
      fallos.push(`${url} -> respuesta sin RSS (${stdout.length} bytes)`);
    } catch (e) {
      fallos.push(`${url} -> ${e.message.split('\n')[0]}`);
    }
  }

  throw new Error(`Ninguna fuente devolvio un feed valido:\n  ${fallos.join('\n  ')}`);
}

// --- Parseo --------------------------------------------------------------

function extraerEntradas(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: true,
    htmlEntities: true
  });

  const doc = parser.parse(xml);
  const canal = doc?.rss?.channel;
  if (!canal) throw new Error('El XML no tiene la forma de un RSS con <channel>');

  const bruto = canal.item ?? [];
  const items = Array.isArray(bruto) ? bruto : [bruto];

  return items
    .map(item => {
      const link = String(item.link ?? '');
      // El guid de Nitter ya es el ID numerico; si no, se saca del enlace.
      const id = String(item.guid?.['#text'] ?? item.guid ?? '').match(/\d+/)?.[0]
        ?? link.match(/status\/(\d+)/)?.[1]
        ?? null;

      return {
        id,
        titulo: String(item.title ?? '').trim(),
        autor: String(item['dc:creator'] ?? '').trim(),
        fecha: item.pubDate ? new Date(item.pubDate) : null
      };
    })
    .filter(e => e.id && e.titulo)
    // Un retweet aparece con el autor original, no con @realmadrid.
    .filter(e => !SALTAR_RETWEETS || e.autor.toLowerCase() === `@${CUENTA}`)
    // De mas antiguo a mas nuevo, para que el orden en Bluesky sea el correcto.
    .sort((a, b) => (a.fecha?.getTime() ?? 0) - (b.fecha?.getTime() ?? 0));
}

// --- Cache ---------------------------------------------------------------

async function leerCache() {
  try {
    const datos = JSON.parse(await readFile(CACHE_FILE, 'utf-8'));
    return { ids: new Set(datos.ids ?? []), existia: true };
  } catch {
    return { ids: new Set(), existia: false };
  }
}

async function guardarCache(ids) {
  const lista = [...ids].slice(-LIMITE_CACHE);
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify({ ids: lista }, null, 2));
  console.log(`Cache guardada: ${lista.length} IDs en ${CACHE_FILE}`);
}

// --- Composicion del texto ----------------------------------------------

function componerTexto(entrada) {
  const enlace = `https://x.com/${CUENTA}/status/${entrada.id}`;
  const completo = `${entrada.titulo}\n\n${enlace}`;

  if (new RichText({ text: completo }).graphemeLength <= LIMITE_GRAFEMAS) return completo;

  // Recorta el titulo, nunca el enlace.
  const margen = new RichText({ text: `\n\n${enlace}` }).graphemeLength + 1;
  const grafemas = [...new Intl.Segmenter().segment(entrada.titulo)].map(s => s.segment);
  const recortado = grafemas.slice(0, LIMITE_GRAFEMAS - margen).join('').trimEnd();

  return `${recortado}…\n\n${enlace}`;
}

// --- Programa principal --------------------------------------------------

async function main() {
  const usuario = process.env.BLUESKY_USERNAME;
  const contrasena = process.env.BLUESKY_PASSWORD;

  if (!DRY_RUN && (!usuario || !contrasena)) {
    throw new Error('Faltan los secrets BLUESKY_USERNAME o BLUESKY_PASSWORD');
  }

  const entradas = extraerEntradas(await descargarFeed());
  console.log(`Entradas en el feed: ${entradas.length}`);

  const { ids: vistos, existia } = await leerCache();
  const nuevas = entradas.filter(e => !vistos.has(e.id));
  console.log(`Ya publicadas: ${vistos.size} | Nuevas: ${nuevas.length}`);

  // Primera ejecucion: solo se memoriza el estado actual, sin publicar nada.
  // Evita volcar de golpe las 20 entradas que trae el feed.
  if (!existia) {
    console.log('No habia cache. Se marca todo como visto y no se publica nada en esta primera vuelta.');
    await guardarCache(new Set(entradas.map(e => e.id)));
    return;
  }

  if (nuevas.length === 0) {
    console.log('Nada nuevo que publicar.');
    await guardarCache(vistos);
    return;
  }

  const aPublicar = nuevas.slice(0, MAX_POR_EJECUCION);
  if (nuevas.length > aPublicar.length) {
    console.log(`Limitado a ${MAX_POR_EJECUCION} por ejecucion; el resto ira en la siguiente.`);
  }

  let agent = null;
  if (!DRY_RUN) {
    agent = new AtpAgent({ service: process.env.SERVICE_URL ?? 'https://bsky.social' });
    await agent.login({ identifier: usuario, password: contrasena });
  }

  let publicadas = 0;
  for (const entrada of aPublicar) {
    const texto = componerTexto(entrada);

    if (DRY_RUN) {
      console.log(`\n--- [simulacion] ${entrada.id} ---\n${texto}`);
      vistos.add(entrada.id);
      publicadas++;
      continue;
    }

    try {
      const rt = new RichText({ text: texto });
      await rt.detectFacets(agent);

      await agent.post({
        $type: 'app.bsky.feed.post',
        text: rt.text,
        facets: rt.facets,
        langs: ['es'],
        createdAt: new Date().toISOString()
      });

      vistos.add(entrada.id);
      publicadas++;
      console.log(`Publicado ${entrada.id}: ${entrada.titulo.slice(0, 60)}`);
    } catch (e) {
      // No se marca como visto: se reintentara en la proxima ejecucion.
      console.error(`Fallo al publicar ${entrada.id}: ${e.message}`);
    }
  }

  await guardarCache(vistos);
  console.log(`\nTotal publicado en esta ejecucion: ${publicadas}`);
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
