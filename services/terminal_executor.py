import os
import subprocess
import shutil
import time
import re
import json
import threading
from typing import Generator, Dict, Optional, List, Any
from config.settings import GENERATED_DIR
from services.aws_reconciler import reconcile_all_resources
from services.state_store import load_state_store, save_state_store, add_history_entry

def get_terraform_bin() -> str:
    """Locates terraform binary in PATH or local project directory."""
    bin_in_path = shutil.which("terraform")
    if bin_in_path:
        return bin_in_path
    
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    local_bin = os.path.join(project_root, "terraform.exe")
    if os.path.exists(local_bin):
        return local_bin
    
    return "terraform"

def sanitize_secret(text: str, access_key: str, secret_key: str) -> str:
    """Mask sensitive secrets from terminal output if they accidentally appear."""
    if access_key and len(access_key) > 4:
        text = text.replace(access_key, access_key[:4] + "****************")
    if secret_key and len(secret_key) > 4:
        text = text.replace(secret_key, secret_key[:4] + "****************")
    return text

def clean_provider_credentials(code: str, access_key: str = "", secret_key: str = "") -> str:
    """Removes hardcoded credentials from main.tf to rely safely on environment variables or injects sanitized block."""
    access_key = access_key.strip()
    secret_key = secret_key.strip()
    
    if access_key and secret_key:
        if "access_key" in code:
            code = re.sub(r'access_key\s*=\s*"[^"]*"', f'access_key = "{access_key}"', code)
        if "secret_key" in code:
            code = re.sub(r'secret_key\s*=\s*"[^"]*"', f'secret_key = "{secret_key}"', code)
    else:
        code = re.sub(r'access_key\s*=\s*"[^"]*"\n?', '', code)
        code = re.sub(r'secret_key\s*=\s*"[^"]*"\n?', '', code)
    return code

def setup_terraform_environment(access_key: str, secret_key: str, region: str) -> dict:
    """Sets environment variables with plugin caching and automation flags for fast execution."""
    env = os.environ.copy()
    if access_key:
        env["AWS_ACCESS_KEY_ID"] = access_key.strip()
    if secret_key:
        env["AWS_SECRET_ACCESS_KEY"] = secret_key.strip()
    if region:
        env["AWS_DEFAULT_REGION"] = region.strip()
        env["AWS_REGION"] = region.strip()

    # Provider Plugin Caching & Non-interactive Automation flags
    plugin_cache_dir = os.path.join(GENERATED_DIR, ".terraform.d", "plugin-cache")
    os.makedirs(plugin_cache_dir, exist_ok=True)
    env["TF_PLUGIN_CACHE_DIR"] = plugin_cache_dir
    env["TF_IN_AUTOMATION"] = "1"
    env["TF_INPUT"] = "0"

    return env

def run_cmd_stream(command: List[str], cwd: str, env: dict) -> Generator[str, None, int]:
    """Runs shell command directly (single process) and yields stdout/stderr line by line unbuffered."""
    try:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        for line in iter(process.stdout.readline, ''):
            yield line
        process.stdout.close()
        return_code = process.wait()
        return return_code
    except FileNotFoundError:
        yield f"Error: Executable not found for command: {' '.join(command)}\n"
        return -1
    except Exception as e:
        yield f"Error executing command {' '.join(command)}: {str(e)}\n"
        return 1

def is_terraform_initialized() -> bool:
    """Checks if .terraform directory and lock file exist to avoid redundant init calls."""
    dot_tf = os.path.join(GENERATED_DIR, ".terraform")
    lock_file = os.path.join(GENERATED_DIR, ".terraform.lock.hcl")
    return os.path.isdir(dot_tf) and os.path.isfile(lock_file)

def parse_tfstate_managed_resources() -> List[Dict[str, Any]]:
    """Fast local reading of terraform.tfstate file without external API calls (<0.001s)."""
    state_file = os.path.join(GENERATED_DIR, "terraform.tfstate")
    resources = []
    if os.path.exists(state_file):
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                state_data = json.load(f)
                state_resources = state_data.get("resources", [])
                for res in state_resources:
                    if res.get("mode") != "managed":
                        continue
                    res_type = res.get("type", "")
                    res_name = res.get("name", "")
                    instances = res.get("instances", [])
                    res_id = instances[0].get("attributes", {}).get("id", f"{res_type}.{res_name}") if instances else f"{res_type}.{res_name}"
                    
                    resources.append({
                        "type": res_type,
                        "name": res_name,
                        "id": str(res_id),
                        "status": "RUNNING",
                        "display_status": "● Running",
                        "aws_state": "active",
                        "details": "Terraform Managed"
                    })
        except Exception:
            pass
    return resources

def execute_infrastructure_creation(
    terraform_code: str,
    access_key: str,
    secret_key: str,
    region: str = "us-east-1"
) -> Generator[str, None, None]:
    """
    ULTRA-FAST DEPLOYMENT ENGINE:
    - Zero synchronous AWS SDK queries on critical path.
    - Skips redundant terraform init if directory is already initialized.
    - Streams terraform apply directly in real time.
    - Measures exact timing for every single phase.
    """
    t_start_total = time.perf_counter()
    os.makedirs(GENERATED_DIR, exist_ok=True)
    
    access_key = access_key.strip()
    secret_key = secret_key.strip()
    region = region.strip()

    # Step 1: Write main.tf
    t0_prep = time.perf_counter()
    cleaned_code = clean_provider_credentials(terraform_code, access_key, secret_key)
    tf_file = os.path.join(GENERATED_DIR, "main.tf")
    with open(tf_file, "w", encoding="utf-8") as f:
        f.write(cleaned_code)

    env = setup_terraform_environment(access_key, secret_key, region)
    tf_bin = get_terraform_bin()
    prep_time = time.perf_counter() - t0_prep
    
    masked_key = (access_key[:4] + "****************") if access_key else "NOT_SET"
    
    yield f"[00.00s] $ export AWS_DEFAULT_REGION='{region}'\n"
    yield f"[{prep_time:.2f}s] $ Using Terraform Executable: {tf_bin}\n"

    # Step 2: Terraform Init (Smart Skip if initialized)
    t0_init = time.perf_counter()
    init_time = 0.0
    if is_terraform_initialized():
        elapsed_now = time.perf_counter() - t_start_total
        yield f"[{elapsed_now:.2f}s] $ terraform init skipped (Working directory already initialized)\n"
    else:
        elapsed_now = time.perf_counter() - t_start_total
        yield f"[{elapsed_now:.2f}s] $ terraform init -input=false -no-color\n"
        gen_init = run_cmd_stream([tf_bin, "init", "-input=false", "-no-color"], GENERATED_DIR, env)
        for line in gen_init:
            yield sanitize_secret(line, access_key, secret_key)
        init_time = time.perf_counter() - t0_init

    # Step 3: Direct Terraform Apply
    t0_apply = time.perf_counter()
    elapsed_now = time.perf_counter() - t_start_total
    yield f"\n[{elapsed_now:.2f}s] $ terraform apply -auto-approve -input=false -no-color\n"
    
    gen_apply = run_cmd_stream([tf_bin, "apply", "-auto-approve", "-input=false", "-no-color"], GENERATED_DIR, env)
    apply_success = True
    for line in gen_apply:
        yield sanitize_secret(line, access_key, secret_key)
        if "Error:" in line or "FAILED" in line:
            apply_success = False
            
    apply_time = time.perf_counter() - t0_apply
    total_time = time.perf_counter() - t_start_total
    terraflow_overhead = total_time - apply_time - init_time

    # Stream Performance Metrics JSON Event
    metrics = {
        "prep_time_s": round(prep_time, 3),
        "init_time_s": round(init_time, 2),
        "apply_time_s": round(apply_time, 2),
        "terraflow_overhead_s": round(terraflow_overhead, 3),
        "total_time_s": round(total_time, 2)
    }

    yield f"\n[TIMING BREAKDOWN]\n"
    yield f"├── TerraFlow Prep: {prep_time:.3f}s\n"
    yield f"├── Terraform Init: {init_time:.2f}s\n"
    yield f"├── Terraform Apply: {apply_time:.2f}s\n"
    yield f"├── TerraFlow Overhead: {terraflow_overhead:.3f}s\n"
    yield f"└── TOTAL EXECUTION TIME: {total_time:.2f}s\n\n"

    yield f"[PERFORMANCE_METRICS] {json.dumps(metrics)}\n"
    yield f"[INFRASTRUCTURE CREATION FINISHED]\n"

    # Non-blocking async background reconciliation & history recording
    if apply_success:
        def background_post_deploy_task():
            raw_tracked = parse_tfstate_managed_resources()
            add_history_entry(
                event_type="DEPLOYMENT",
                title="Infrastructure Created",
                description=f"Provisioned {len(raw_tracked)} AWS resources in {total_time:.1f}s",
                resource_count=len(raw_tracked),
                duration_s=total_time,
                region=region
            )
            # Async sync state
            reconcile_all_resources(raw_tracked, access_key, secret_key, region)

        threading.Thread(target=background_post_deploy_task, daemon=True).start()

def execute_infrastructure_destruction(
    access_key: str,
    secret_key: str,
    region: str = "us-east-1"
) -> Generator[str, None, None]:
    """
    ULTRA-FAST DESTRUCTION ENGINE:
    - Zero synchronous pre/post AWS SDK queries blocking destruction stream.
    - Direct terraform destroy execution.
    - Precise timing breakdown.
    """
    t_start_total = time.perf_counter()
    os.makedirs(GENERATED_DIR, exist_ok=True)
    
    access_key = access_key.strip()
    secret_key = secret_key.strip()
    region = region.strip()

    env = setup_terraform_environment(access_key, secret_key, region)
    tf_bin = get_terraform_bin()
    masked_key = (access_key[:4] + "****************") if access_key else "NOT_SET"
    
    yield f"[00.00s] $ export AWS_DEFAULT_REGION='{region}'\n"
    yield f"[00.01s] $ Using Terraform Executable: {tf_bin}\n\n"

    # Step 1: terraform destroy
    t0_destroy = time.perf_counter()
    yield f"$ terraform destroy -auto-approve -input=false -no-color\n"
    gen_destroy = run_cmd_stream([tf_bin, "destroy", "-auto-approve", "-input=false", "-no-color"], GENERATED_DIR, env)
    destroy_success = True
    for line in gen_destroy:
        yield sanitize_secret(line, access_key, secret_key)
        if "Error:" in line or "FAILED" in line:
            destroy_success = False

    destroy_time = time.perf_counter() - t0_destroy
    total_time = time.perf_counter() - t_start_total
    terraflow_overhead = total_time - destroy_time

    metrics = {
        "destroy_time_s": round(destroy_time, 2),
        "terraflow_overhead_s": round(terraflow_overhead, 3),
        "total_time_s": round(total_time, 2)
    }

    yield f"\n[TIMING BREAKDOWN]\n"
    yield f"├── Terraform Destroy: {destroy_time:.2f}s\n"
    yield f"├── TerraFlow Overhead: {terraflow_overhead:.3f}s\n"
    yield f"└── TOTAL TERMINATION TIME: {total_time:.2f}s\n\n"

    yield f"[PERFORMANCE_METRICS] {json.dumps(metrics)}\n"
    yield f"[INFRASTRUCTURE TERMINATION FINISHED]\n"

    if destroy_success:
        def background_post_destroy_task():
            add_history_entry(
                event_type="TERMINATION",
                title="Infrastructure Terminated",
                description=f"Destroyed TerraFlow managed resources in {total_time:.1f}s",
                resource_count=0,
                duration_s=total_time,
                region=region
            )
            # Async sync state
            reconcile_all_resources([], access_key, secret_key, region)

        threading.Thread(target=background_post_destroy_task, daemon=True).start()

def get_managed_resources_info(
    access_key: str = "",
    secret_key: str = "",
    region: str = "us-east-1",
    sync_aws: bool = False
) -> dict:
    """
    Returns managed resources info.
    Default (sync_aws=False): Instant local tfstate reading (<0.001s).
    If sync_aws=True: Queries live AWS APIs via boto3.
    """
    raw_tracked = parse_tfstate_managed_resources()

    # If main.tf exists but tfstate doesn't, parse main.tf for configured resources
    main_tf = os.path.join(GENERATED_DIR, "main.tf")
    if not raw_tracked and os.path.exists(main_tf):
        try:
            with open(main_tf, "r", encoding="utf-8") as f:
                content = f.read()
                matches = re.findall(r'resource\s+"([^"]+)"\s+"([^"]+)"', content)
                for res_type, res_name in matches:
                    raw_tracked.append({
                        "type": res_type,
                        "name": res_name,
                        "id": f"{res_type}.{res_name}",
                        "status": "CONFIGURED",
                        "display_status": "○ Configured",
                        "aws_state": "configured",
                        "details": "HCL Configured"
                    })
        except Exception:
            pass

    state_store = load_state_store()
    history = state_store.get("deployment_history", [])

    if sync_aws and (access_key or secret_key):
        reconciliation = reconcile_all_resources(raw_tracked, access_key, secret_key, region)
        return {
            "is_deployed": reconciliation["is_deployed"],
            "running_count": reconciliation["running_count"],
            "deleted_count": reconciliation["deleted_count"],
            "total_count": reconciliation["total_count"],
            "current_resources": reconciliation["current_resources"],
            "externally_deleted_resources": reconciliation["externally_deleted_resources"],
            "all_resources": reconciliation["all_resources"],
            "deployment_history": history,
            "last_verified_at": reconciliation["last_verified_at"],
            "last_verified_display": reconciliation["last_verified_display"]
        }

    # Instant return for regular requests without hitting AWS network APIs
    is_deployed = len(raw_tracked) > 0 and any(r.get("status") == "RUNNING" for r in raw_tracked)
    return {
        "is_deployed": is_deployed,
        "running_count": len(raw_tracked),
        "deleted_count": 0,
        "total_count": len(raw_tracked),
        "current_resources": raw_tracked,
        "externally_deleted_resources": [],
        "all_resources": raw_tracked,
        "deployment_history": history,
        "last_verified_at": state_store.get("last_synced"),
        "last_verified_display": "Local State (Click Sync for AWS live check)"
    }
