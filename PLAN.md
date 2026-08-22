# PLAN — Fix lentitud opencode/OpenChamber (16/08/2026)

## Contexto
- 6+ procesos opencode compartiendo opencode.db 3.93GB (event 67K/1.47GB, message 122K, part 408K) → stalls DB, /session cuelga.
- Boot managed ~2.5-3min: warmup serial multi-directorio; app instalada (asar 14/08 22:35) SIN los fixes del fork (77d51d207: WARMUP_CONCURRENCY=2, filtro worktrees, timeout 5s; dd02d2e16: session merge paralelo).
- Duplicación MCP 4x via self-connections /event; tormenta proxy 'socket hang up' en main.log.
- Config CLI: 20 MCP + SessionStart hook a script inexistente.

## Fases
1. [DONE] Wave0: auditoría (procesos, DB, logs, fork, proxy).
2. [DONE] Wave2: poda backups (11.5+1.6+1.7GB) + magic-context 131MB + session_diff >20MB (238MB) + prune events (67K→49K, 3.93→3.69GB). Script prune reparado (bloque duplicado, línea truncada).
3. [DONE] Wave4: rebuild main.mjs + repack app.asar (--unpack node_modules, 2.5MB) + sync packages/web -> @openchamber/web (warmup paralelo, session-merge, health tolerance, scoped-config). Backups: app.asar.bak-20260816-pre-sync + unpacked.bak.
4. [DONE] Wave3: OpenChamber relanzado 12:20. PushWatcher connected en 1s (antes 2.5min). Gate /session 200 OK 3-90ms (28KB). 0 proxy errors. Health flapping (contention DB con 2 TUIs + managed) -> restart ciclico rapido OK.
5. [DONE] Wave5: hook SessionStart roto eliminado de opencode.jsonc.
6. [DONE] QA: gate estable 3x, 0 proxy errors, boot 1s. Pendiente: ver UI en vivo.

## Nota previa (sesión 15/08 23:45)
- 11 AppHangB1 de OpenChamber.exe (20:31-23:39): el main de Electron se cuelga → proxy deja de procesar → socket hang up → UI congelada → se recupera → repite.


## Prevencion de recurrencia (16/08/2026)

### Reglas de oro
1. **Max 2 instancias opencode simultaneas** (1 TUI + managed). Cada instancia comparte opencode.db (SQLite sync) — 3+ instancias = stalls de /session. Cierra TUIs que no uses.
2. **Tras cada auto-update de OpenChamber**, verificar drift:
   `node scripts/sync-installed.mjs --check` (exit 0 = OK; exit 2 = drift)
3. **Antes de cualquier sync**: cerrar OpenChamber completo (bandeja -> Quit).

### Mantenimiento
- **Sync fork -> app instalada** (trae fixes de warmup/session-merge/health):
  `node scripts/sync-installed.mjs` (con OpenChamber cerrado; backups automaticos en resources/)
- **Prune event store**: tarea programada `PruneOpenCodeEventStore` SEMANAL (domingos 04:30,
  cambio hecho 16/08; antes mensual y nunca habia corrido). Manual:
  `bun C:\Users\herna\.config\opencode\scripts\prune-opencode-db.js --hours=24`
- **Reinicio limpio** (si managed muere): bandeja -> Quit, verificar
  `Get-Process opencode,OpenChamber` vacio, relanzar OpenChamber.

### Health check rapido
- Gate: `Invoke-WebRequest http://127.0.0.1:57123/session -Headers @{Authorization="Bearer <token config>"}`
  → 200 y <500ms = sano. Proxy errors crecientes en main.log = managed colgado.
- Si vuelve la lentitud: `Get-Process opencode` → si >2, cerrar extras y reiniciar limpio.
