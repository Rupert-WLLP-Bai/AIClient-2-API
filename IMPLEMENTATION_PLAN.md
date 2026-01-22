# Problem statement
Identify and implement high‑value improvements in security, reliability, and developer experience based on the current codebase.

# Current state (high level)
The server boots via `src/services/api-server.js` and logs configuration details on startup (including the required API key). `createRequestHandler` in `src/handlers/request-handler.js` routes API and UI requests and relies on `serveStaticFiles` in `src/services/ui-manager.js` to serve static assets. UI config endpoints return the in‑memory config and write updates to `configs/config.json` in `src/ui-modules/config-api.js`. OAuth credential uploads are handled by `handleUploadOAuthCredentials` in `src/ui-modules/event-broadcast.js` and a similar upload flow in the potluck plugin (`src/plugins/api-potluck/api-routes.js`). JSON body parsing is done in `getRequestBody` without a size cap in `src/utils/common.js`. There are Jest tests, but `tests/cors-config.test.js` imports a non‑existent module path.

# Proposed changes
1. Harden static file and upload path handling
* Add a safe‑path resolver for static files so requests can only serve files under the `static/` directory, preventing path traversal (current logic simply joins paths). Update `serveStaticFiles` accordingly. `src/services/ui-manager.js (24-40)`.
* Validate/sanitize provider names used to determine upload directories and ensure the resolved target directory stays within `configs/`. Apply to both UI uploads and potluck user uploads. `src/ui-modules/event-broadcast.js (211-233)` and `src/plugins/api-potluck/api-routes.js (748-766)`.

2. Reduce secret exposure in logs and UI config responses
* Mask or omit sensitive fields in startup logs (API key currently logged). `src/services/api-server.js:279`.
* Redact secrets in `GET /api/config` responses (e.g., API keys, tokens, credential file paths) and only expose them when explicitly requested (e.g., an opt‑in query param). `src/ui-modules/config-api.js (48-63)`.
* Optionally hash the admin password stored in `configs/pwd` and compare hashes instead of plaintext (introduce migration that accepts plaintext once, then replaces with a hash). `src/ui-modules/auth.js (6-40)`.

3. Add request body size limits and consistent JSON parsing errors
* Extend `getRequestBody` to enforce a maximum size (e.g., 1–2MB) and return 413 when exceeded; reuse this helper in other parsers (e.g., potluck routes) to reduce duplicate logic. `src/utils/common.js (120-145)`.

4. Make config updates safer and more robust
* Validate update payloads (types, ranges, enum values) before mutating in‑memory config; normalize `MODEL_PROVIDER` the same way as at startup so UI updates don’t leave `DEFAULT_MODEL_PROVIDERS` inconsistent. `src/ui-modules/config-api.js (70-175)` and `src/core/config-manager.js (6-90)`.
* Write `configs/config.json` atomically (write to temp + rename) to avoid corruption on partial writes. `src/ui-modules/config-api.js (121-175)`.

5. Improve test reliability
* Fix the import path in `tests/cors-config.test.js` to point at `src/handlers/request-handler.js`. `tests/cors-config.test.js:9`.
* Make integration tests configurable via environment variables and auto‑skip if the target server isn’t reachable, to avoid hard‑coded IPs and false failures. `tests/api-integration.test.js (1-40)`.

# Notes on scope
These changes are localized to request routing, config management, uploads, and tests, and do not alter provider protocol logic or adapter behavior.
