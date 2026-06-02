#!/bin/bash
cd /root/arena-fps
npx tsc --noEmit --project tsconfig.json 2>&1 | head -80
