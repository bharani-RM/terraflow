import os
import subprocess
from config.settings import GENERATED_DIR

def format_terraform(code: str) -> str:
    """
    Saves the HCL code to a file and runs `terraform fmt` with timeout protection.
    Returns the formatted HCL code.
    """
    file_path = os.path.join(GENERATED_DIR, "main.tf")
    
    # Save the code
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(code)
        
    try:
        from services.terminal_executor import get_terraform_bin
        tf_bin = get_terraform_bin()

        # Run terraform fmt with 5s timeout
        result = subprocess.run(
            [tf_bin, "fmt", "main.tf"],
            cwd=GENERATED_DIR,
            capture_output=True,
            text=True,
            check=True,
            timeout=5
        )
        
        # Read the formatted code back
        with open(file_path, "r", encoding="utf-8") as f:
            formatted_code = f.read()
            
        return formatted_code
    except Exception:
        # If terraform fmt fails, times out, or CLI is missing, return original code
        return code
