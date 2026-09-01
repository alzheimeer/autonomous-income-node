@echo off
onchainos agent create --name "AIN" --role asp --description "AI text and code generation" --picture "https://static.okx.com/cdn/web3/wallet/marketplace/headimages/agent/avatar/976ad2e9-807b-49c7-9af6-0d7490b8548d.png" --service "[{\"serviceName\":\"TextGen\",\"serviceDescription\":\"AI text generation\",\"serviceType\":\"A2MCP\",\"fee\":\"0.50\",\"endpoint\":\"https://example.com/api\"}]"
pause
