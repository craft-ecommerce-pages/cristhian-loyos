# Handoff B — Google Wallet

## Qué hice

- Implementé `walletEnabled`, `walletSaveUrl`, `walletSync` y `walletNotify` sin dependencias npm.
- Implementé JWT RS256 con WebCrypto y service account PKCS8, intercambio OAuth con scope `wallet_object.issuer` y caché por credencial hasta cinco minutos antes del vencimiento. Las renovaciones concurrentes comparten una sola promesa.
- Implementé la clase de fidelización por slug, con validación de color/logo, fallback de marca, GET→POST/PUT y hash en KV `{slug}:wallet_class` para omitir consultas repetidas.
- Implementé el objeto de fidelización con sellos, total de premios activos, QR, enlaces y hasta cinco premios visibles.
- Implementé sincronización best-effort por PUT: 404 es no-op y ningún error escapa hacia el flujo de jugada.
- Implementé campañas `addMessage` con concurrencia máxima de seis, IDs únicos y degradación `TEXT_AND_NOTIFY` → `TEXT` cuando Google responde 429 o `QuotaExceeded`.
- Agregué tests aislados con `fetch` simulado: ninguna prueba usa Google ni Cloudflare reales.

## Decisiones

- El hash KV representa exactamente la clase deseada. Si falta o cambió, se consulta Google; una clase existente solo recibe PUT cuando cambió nombre, logo o color.
- `secondaryLoyaltyPoints` muestra el total de premios activos; el límite de cinco aplica únicamente a `textModulesData`.
- Las respuestas OAuth y de lectura de clase se tratan como entrada no confiable y se valida su forma antes de usarlas.
- Los errores registran contexto genérico y estado HTTP, nunca el token, JWT ni la clave privada.
- `walletSaveUrl` sí propaga fallos porque no puede entregar un enlace válido; `walletSync` y cada destinatario de `walletNotify` son best-effort según el contrato.

## Cómo probar

```bash
node --check loyalty/src/wallet.js
node --test loyalty/test/
```

Resultado al entregar: 13 tests verdes (8 de Wallet y 5 del contrato).

## Riesgos / seguimiento

- No hubo prueba contra Google real por regla del workstream. El integrador debe validar en un issuer de prueba que la clase quede aprobada y que Google acepte la forma exacta de `secondaryLoyaltyPoints` y `textModulesData` antes de producción.
- El hash de clase vive en el KV compartido. Si la clase se modifica manualmente en Google mientras el hash local sigue vigente, no se reconciliará hasta cambiar/borrar `{slug}:wallet_class`.
- Google puede aplicar límites adicionales al tamaño de textos o a la frecuencia de mensajes; la API admin ya limita título/cuerpo y destinatarios según `PLAN.md`.
