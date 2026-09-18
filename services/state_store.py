import os
import json
from datetime import datetime
from typing import Dict, List, Any
from config.settings import GENERATED_DIR

STATE_FILE = os.path.join(GENERATED_DIR, "terraflow_state.json")

def get_default_state() -> Dict[str, Any]:
    return {
        "last_synced": None,
        "is_deployed": False,
        "managed_resources": [],
        "reconciled_resources": [],
        "externally_deleted_resources": [],
        "deployment_history": []
    }

def load_state_store() -> Dict[str, Any]:
    os.makedirs(GENERATED_DIR, exist_ok=True)
    if not os.path.exists(STATE_FILE):
        default_state = get_default_state()
        save_state_store(default_state)
        return default_state
    
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return get_default_state()

def save_state_store(data: Dict[str, Any]) -> None:
    os.makedirs(GENERATED_DIR, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def add_history_entry(
    event_type: str, # "DEPLOYMENT", "TERMINATION", "EXTERNAL_DELETION", "SYNC"
    title: str,
    description: str,
    resource_count: int = 0,
    duration_s: float = 0.0,
    region: str = "us-east-1"
) -> Dict[str, Any]:
    state = load_state_store()
    history = state.get("deployment_history", [])

    entry = {
        "id": f"evt-{int(datetime.now().timestamp())}",
        "timestamp": datetime.now().isoformat(),
        "display_time": datetime.now().strftime("%b %d, %Y — %I:%M %p"),
        "event_type": event_type,
        "title": title,
        "description": description,
        "resource_count": resource_count,
        "duration_s": round(duration_s, 2),
        "region": region
    }

    # Prepend latest event
    history.insert(0, entry)

    # Keep last 50 historical entries
    state["deployment_history"] = history[:50]
    save_state_store(state)
    return entry
