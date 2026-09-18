import os
import io
import time
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional

from config.settings import GROQ_API_KEY, GENERATED_DIR
from services.pdf_processor import extract_text_from_pdf
from services.text_processor import clean_text, is_terraform_relevant
from services.requirement_analyzer import analyze_requirements
from services.terraform_generator import generate_terraform
from services.terraform_formatter import format_terraform
from services.terraform_validator import validate_terraform
from services.aws_reconciler import verify_aws_account
from services.terminal_executor import (
    execute_infrastructure_creation,
    execute_infrastructure_destruction,
    get_managed_resources_info
)

app = FastAPI(
    title="AI Terraform Code Generator & AWS Deployer",
    description="Containerized API & Web Dashboard for AI Terraform Generation and Automated AWS Deployment",
    version="2.0.0"
)

# Ensure static directory exists
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

class GenerateRequest(BaseModel):
    input_text: str
    aws_access_key: Optional[str] = ""
    aws_secret_key: Optional[str] = ""

class DeployRequest(BaseModel):
    terraform_code: str
    aws_access_key: Optional[str] = ""
    aws_secret_key: Optional[str] = ""
    aws_region: Optional[str] = "us-east-1"

class DestroyRequest(BaseModel):
    aws_access_key: Optional[str] = ""
    aws_secret_key: Optional[str] = ""
    aws_region: Optional[str] = "us-east-1"

class ValidateRequest(BaseModel):
    terraform_code: str

class VerifyAwsRequest(BaseModel):
    aws_access_key: Optional[str] = ""
    aws_secret_key: Optional[str] = ""
    aws_region: Optional[str] = "us-east-1"

class SyncRequest(BaseModel):
    aws_access_key: Optional[str] = ""
    aws_secret_key: Optional[str] = ""
    aws_region: Optional[str] = "us-east-1"

@app.get("/", response_class=HTMLResponse)
def read_root():
    """Serves the main single-page application dashboard."""
    index_path = os.path.join("static", "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return HTMLResponse("<h1>API operational. Dashboard file static/index.html not found.</h1>")

@app.post("/api/aws/verify-account")
def api_verify_aws_account(req: VerifyAwsRequest):
    """Verifies AWS credentials using STS GetCallerIdentity and returns account details."""
    return verify_aws_account(
        access_key=req.aws_access_key or "",
        secret_key=req.aws_secret_key or "",
        region=req.aws_region or "us-east-1"
    )

@app.post("/api/aws/sync")
def api_sync_aws(req: SyncRequest):
    """Performs real-time reconciliation of TerraFlow resources against live AWS APIs via boto3."""
    return get_managed_resources_info(
        access_key=req.aws_access_key or "",
        secret_key=req.aws_secret_key or "",
        region=req.aws_region or "us-east-1",
        sync_aws=True
    )

@app.post("/api/upload-pdf")
async def upload_pdf(file: UploadFile = File(...)):
    """Extracts text from an uploaded PDF requirement file."""
    try:
        content = await file.read()
        pdf_file = io.BytesIO(content)
        extracted_text = extract_text_from_pdf(pdf_file)
        return {"extracted_text": extracted_text}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PDF extraction error: {str(e)}")

@app.post("/api/generate")
def generate_code(req: GenerateRequest):
    """Generates formatted, syntax-checked Terraform HCL code from natural language requirements."""
    if not GROQ_API_KEY or GROQ_API_KEY == "your_groq_api_key_here":
        raise HTTPException(status_code=500, detail="GROQ_API_KEY is missing or invalid in environment settings.")

    cleaned_text = clean_text(req.input_text)
    if not is_terraform_relevant(cleaned_text):
        raise HTTPException(status_code=400, detail="Input does not appear to contain valid Terraform infrastructure requirements.")

    try:
        # Step 1: Analyze requirements using AI
        requirements = analyze_requirements(cleaned_text)

        # Step 2: Generate Terraform HCL
        raw_code = generate_terraform(
            requirements,
            access_key=req.aws_access_key or "",
            secret_key=req.aws_secret_key or ""
        )

        # Step 3: Format & validate syntax
        formatted_code = format_terraform(raw_code)

        os.makedirs(GENERATED_DIR, exist_ok=True)
        main_tf_path = os.path.join(GENERATED_DIR, "main.tf")
        with open(main_tf_path, "w", encoding="utf-8") as f:
            f.write(formatted_code)

        is_valid, err_msg = validate_terraform()

        return {
            "success": True,
            "terraform_code": formatted_code,
            "is_valid": is_valid,
            "validation_error": err_msg
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Generation failed: {str(e)}")

@app.post("/api/deploy")
def deploy_infrastructure(req: DeployRequest):
    """Executes terraform init -> plan -> apply pipeline and streams execution logs line-by-line."""
    def log_stream():
        generator = execute_infrastructure_creation(
            terraform_code=req.terraform_code,
            access_key=req.aws_access_key or "",
            secret_key=req.aws_secret_key or "",
            region=req.aws_region or "us-east-1"
        )
        for chunk in generator:
            yield chunk

    return StreamingResponse(log_stream(), media_type="text/plain; charset=utf-8")

@app.post("/api/destroy")
def destroy_infrastructure(req: DestroyRequest):
    """Executes terraform destroy pipeline and streams execution logs line-by-line."""
    def log_stream():
        generator = execute_infrastructure_destruction(
            access_key=req.aws_access_key or "",
            secret_key=req.aws_secret_key or "",
            region=req.aws_region or "us-east-1"
        )
        for chunk in generator:
            yield chunk

    return StreamingResponse(log_stream(), media_type="text/plain; charset=utf-8")

@app.post("/api/validate")
def validate_code(req: ValidateRequest):
    """Validates submitted Terraform HCL code."""
    try:
        if req.terraform_code:
            os.makedirs(GENERATED_DIR, exist_ok=True)
            main_tf_path = os.path.join(GENERATED_DIR, "main.tf")
            with open(main_tf_path, "w", encoding="utf-8") as f:
                f.write(req.terraform_code)

        is_valid, err_msg = validate_terraform()
        return {
            "is_valid": is_valid,
            "error": err_msg
        }
    except Exception as e:
        return {"is_valid": False, "error": str(e)}

@app.get("/api/resources")
def get_resources():
    """Returns currently managed resources based on real-time AWS API reconciliation."""
    return get_managed_resources_info()

@app.get("/api/status")
def get_system_status():
    """Returns system status including generated files and terraform deployment status."""
    main_tf_path = os.path.join(GENERATED_DIR, "main.tf")
    has_generated = os.path.exists(main_tf_path)
    res_info = get_managed_resources_info()
    return {
        "has_generated_code": has_generated,
        "is_deployed": res_info.get("is_deployed", False),
        "running_count": res_info.get("running_count", 0),
        "deleted_count": res_info.get("deleted_count", 0),
        "current_resources": res_info.get("current_resources", []),
        "externally_deleted_resources": res_info.get("externally_deleted_resources", []),
        "last_verified_display": res_info.get("last_verified_display", "Not synced yet")
    }

@app.get("/api/download")
def download_terraform_file():
    """Provides generated main.tf as a download."""
    main_tf_path = os.path.join(GENERATED_DIR, "main.tf")
    if os.path.exists(main_tf_path):
        return FileResponse(main_tf_path, filename="main.tf", media_type="text/plain")
    raise HTTPException(status_code=404, detail="No generated main.tf found.")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
