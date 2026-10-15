import json
import sys
import time

request = json.load(sys.stdin)
account = request["account_id"]
if account == "WAIT":
    time.sleep(30)
elif account == "MALFORMED":
    print("not json")
elif account == "OVERSIZE":
    print("x" * 2_000_001)
elif account == "ERROR":
    print(json.dumps({"ok": False, "code": "TWS_NOT_READY", "message": "PRIVATE SESSION DETAILS"}))
else:
    print(json.dumps({"ok": True, "authenticated": True, "complete": True, "accounts": [account],
                      "account_id": account, "positions": [], "quotes": []}))
