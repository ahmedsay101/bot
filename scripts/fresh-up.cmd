@echo off
REM Rebuild & restart the stack with a clean Mongo + Redis state.
pushd "%~dp0\.."
echo ==^> Stopping stack...
docker compose down
echo ==^> Building ^& starting with reset profile...
docker compose --profile reset up -d --build
echo ==^> Waiting for db-reset to finish...
docker compose wait db-reset
echo ==^> Tail bot logs:
docker compose logs -f --tail=50 bot
popd
