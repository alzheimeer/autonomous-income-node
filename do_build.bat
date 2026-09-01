@echo off
cd /d "c:\Users\fogni\OneDrive\Escritorio\proyecto1a\autonomous-income-node"
docker compose build agent > build_result_opts.txt 2>&1
echo BUILD_DONE >> build_result_opts.txt
docker compose up -d agent >> build_result_opts.txt 2>&1
echo DEPLOY_DONE >> build_result_opts.txt
