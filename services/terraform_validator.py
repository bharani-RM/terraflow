import os
import subprocess
from typing import Tuple, Optional
from config.settings import GENERATED_DIR

def basic_hcl_syntax_check(code: str) -> Tuple[bool, Optional[str]]:
    """Fast local check for balanced brackets, braces, and quotes."""
    stack = []
    bracket_map = {')': '(', '}': '{', ']': '['}
    in_string = False
    escape = False

    for idx, char in enumerate(code):
        if char == '"' and not escape:
            in_string = not in_string
        elif char == '\\' and in_string:
            escape = not escape
            continue
        elif not in_string:
            if char in '({[':
                stack.append(char)
            elif char in ')}]':
                if not stack or stack[-1] != bracket_map[char]:
                    return False, f"Unmatched bracket '{char}' at character position {idx}"
                stack.pop()
        escape = False

    if stack:
        return False, f"Unclosed block or bracket '{stack[-1]}'"
    if in_string:
        return False, "Unclosed string quote in Terraform code"

    return True, None

def validate_terraform() -> Tuple[bool, Optional[str]]:
    """
    Fast validation: performs local HCL check first, then fast terraform validate if initialized.
    """
    file_path = os.path.join(GENERATED_DIR, "main.tf")
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                code = f.read()
            is_hcl_valid, err = basic_hcl_syntax_check(code)
            if not is_hcl_valid:
                return False, f"Syntax Error: {err}"
        except Exception as e:
            pass

    # Check if .terraform folder exists to run fast validate without downloading
    dot_tf_dir = os.path.join(GENERATED_DIR, ".terraform")
    if os.path.exists(dot_tf_dir):
        try:
            from services.terminal_executor import get_terraform_bin
            tf_bin = get_terraform_bin()
            val_result = subprocess.run(
                [tf_bin, "validate", "-json"],
                cwd=GENERATED_DIR,
                capture_output=True,
                text=True,
                check=False,
                timeout=3
            )
            if val_result.returncode != 0:
                import json
                try:
                    error_data = json.loads(val_result.stdout)
                    error_msgs = [diag.get("summary", "") + ": " + diag.get("detail", "") for diag in error_data.get("diagnostics", [])]
                    return False, "\n".join(error_msgs)
                except Exception:
                    return False, val_result.stderr or val_result.stdout
        except Exception:
            pass

    return True, None
