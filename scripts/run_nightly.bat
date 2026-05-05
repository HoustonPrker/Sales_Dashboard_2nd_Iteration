@echo off
cd C:\Users\houstonp\Desktop\CK-Analytics-DB
python scripts/export_data.py >> logs\export_%date:~-4,4%-%date:~-10,2%-%date:~7,2%.log 2>&1
