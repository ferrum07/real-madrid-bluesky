# real-madrid-bluesky

Replica automáticamente en Bluesky las publicaciones de [@realmadrid](https://x.com/realmadrid) en X.

## Cómo funciona

Un workflow de GitHub Actions se ejecuta cada 10 minutos, descarga el feed RSS
de la cuenta, compara con lo ya publicado y envía a Bluesky únicamente lo nuevo.

## Por qué no se usa la acción `joschi/blueskyfeedbot`

Se intentó primero, pero no funciona con estas fuentes. Esa acción descarga el
RSS con el `fetch` interno de Node (undici), y las instancias de Nitter le
devuelven **una respuesta vacía** porque filtran por la huella TLS del cliente.
No es cuestión de cabeceras: con el mismo User-Agent de Chrome y el mismo
`Accept`, el resultado sigue siendo 0 bytes.

Comprobado contra `https://nitter.net/realmadrid/rss`:

| Cliente | Resultado |
| --- | --- |
| Navegador / PowerShell | 200, 16 KB de RSS válido |
| `curl` | 200, 16 KB de RSS válido |
| `fetch` de Node (el de la acción) | 200 pero cuerpo vacío |

Por eso la descarga se hace aquí con `curl` y el resto del trabajo lo hace
[`scripts/post-to-bluesky.mjs`](scripts/post-to-bluesky.mjs).

## Puesta en marcha

### 1. Secrets

En *Settings → Secrets and variables → Actions*:

| Secret | Valor |
| --- | --- |
| `BLUESKY_USERNAME` | Tu identificador, por ejemplo `micuenta.bsky.social` |
| `BLUESKY_PASSWORD` | Una **contraseña de aplicación**, no la de tu cuenta. Se crea en Bluesky en *Settings → App Passwords* |

### 2. Comprobar que la fuente responde

Antes de publicar nada, ejecuta a mano el workflow **Sondeo de fuentes RSS**
(*Actions → Sondeo de fuentes RSS → Run workflow*). No publica nada: solo indica
qué fuentes funcionan desde las IPs de GitHub. Busca en la salida la columna
`FEED=SI`.

Si ninguna funciona, significa que Nitter bloquea las IPs de datacenter de
GitHub y hay que ejecutar el script desde un ordenador propio.

### 3. Activar la publicación

El workflow **Real Madrid X a Bluesky** ya está programado. En su **primera
ejecución no publica nada**: se limita a memorizar las publicaciones actuales
para no volcar de golpe las 20 entradas del feed. A partir de la segunda vuelta
publica solo lo nuevo.

## Detalles de diseño

- **Deduplicado por ID de tweet**, no por URL. Así se puede cambiar de instancia
  de Nitter sin que el bot crea que todo es nuevo.
- **Fuentes con reserva**: si `nitter.net` falla, prueba las siguientes de la lista.
- **Máximo 5 publicaciones por ejecución**, para que un fallo de caché no
  provoque una avalancha. El resto sale en la siguiente vuelta.
- **Se ignoran los retweets** (entradas cuyo autor no es `@realmadrid`).
- **Recorte a 300 grafemas**, el límite de Bluesky, respetando siempre el enlace.
- Si una publicación falla, **no se marca como vista** y se reintenta después.

## Probar en local

```bash
npm install
DRY_RUN=true CACHE_FILE=cache/prueba.json npm run post
```

En modo `DRY_RUN` no se conecta a Bluesky: solo imprime por pantalla lo que
publicaría.

## Variables de entorno

| Variable | Por defecto | Para qué sirve |
| --- | --- | --- |
| `BLUESKY_USERNAME` | — | Identificador de la cuenta |
| `BLUESKY_PASSWORD` | — | Contraseña de aplicación |
| `CACHE_FILE` | `cache/vistos.json` | Dónde se guardan los IDs ya publicados |
| `MAX_POSTS_PER_RUN` | `5` | Tope de publicaciones por ejecución |
| `FEEDS` | lista de instancias Nitter | Fuentes alternativas, separadas por comas |
| `SKIP_RETWEETS` | `true` | Poner a `false` para incluir retweets |
| `DRY_RUN` | `false` | `true` para simular sin publicar |

## Aviso

Esta cuenta es un espejo no oficial. El Real Madrid no tiene cuenta propia en
Bluesky y este repositorio no está asociado al club.
