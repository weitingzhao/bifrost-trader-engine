@echo off
cd /d "%~dp0..\.."
echo Installing dependencies...

py -m pip install -r requirements.txt 2>nul && goto :done
python -m pip install -r requirements.txt 2>nul && goto :done
python3 -m pip install -r requirements.txt 2>nul && goto :done

echo.
echo Could not find Python (tried: py, python, python3).
echo Install from https://www.python.org/downloads/ and check "Add Python to PATH".
exit /b 1

:done
echo Done.
exit /b 0
