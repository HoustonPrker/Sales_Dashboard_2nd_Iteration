@echo off
cd /d "%~dp0"
npm install
node server/proxy.js
