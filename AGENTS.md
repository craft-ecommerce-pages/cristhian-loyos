# Proyecto Cristhian Loyos

Responder y documentar en español. Leer `docs/ARQUITECTURA-CLIENTE.md` antes de editar. Este repositorio es una copia aislada por cliente de craft-catalog-engine. No desplegar ni editar el motor compartido. No usar recursos Cloudflare de Craft ni secretos en Git. No exponer datos del RUC o credenciales en logs.

Trabajar solo en los archivos asignados por el arquitecto; cualquier contrato cruzado se comunica mediante un archivo de handoff en `.ops/`. Antes de editar archivos existentes, guardar copia `.ops/backups/<ruta>`. Nunca hacer `DROP`, `DELETE`, `ALTER`, importar datos o reiniciar contenedores sin backup. Mantener respuestas breves y pruebas pertinentes. Tras cambios de código, ejecutar `graphify update .` si Graphify está inicializado.

## Secretos (2026-11-14)

Ya no existen `.env` ni `documentos/clavefirma.env`: están en Bitwarden. Wrangler manual: `con-secretos CLOUDFLARE_API_TOKEN=MUNCH_CLOUDFLARE_API_TOKEN -- npx wrangler ...`. Clave de la firma electrónica: `secretos MUNCH_CLAVE_FIRMA_ELECTRONICA` (nunca imprimirla en logs).
