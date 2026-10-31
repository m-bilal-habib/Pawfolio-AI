@echo off
REM VoxSOAP local quick start - one command, two windows (2026-10-31).
REM   UI:      http://localhost:3000/clinic/vox-soap
REM   Health:  http://127.0.0.1:8321/health
REM   Probe:   node "D:\Pawfolio AI\ml-serving\probe_local_service.mjs"
REM Stop: close the two windows (uvicorn may also be stopped via POST /unload
REM for RAM; Ctrl+C in the windows kills the processes cleanly).
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
start "voxsoap-ml (uvicorn 8321)" /min "D:\Pawfolio AI\.venv-ml64\Scripts\python.exe" -m uvicorn app:app --app-dir "D:\Pawfolio AI\ml-serving" --host 127.0.0.1 --port 8321
start "voxsoap-next (3000)" cmd /k "cd /d D:\Pawfolio AI && npx.cmd next dev --port 3000"
echo Launched: uvicorn 8321 (minimized) + Next dev 3000.
echo Give Next.js ~5-10 s to compile, then open the UI.
