# Containerized AI Terraform Code Generator & AWS Deployer

An AI-powered Natural Language to Terraform HCL Code Generator and Automated AWS Deployment Engine built with FastAPI, PyMuPDF, Groq AI, and Terraform CLI.

This application allows you to input infrastructure requirements as raw text or upload a PDF document containing requirements. The system extracts requirements, generates valid Terraform HCL code, formats syntax using the Terraform CLI, and streams live terminal logs (`terraform init`, `terraform plan`, `terraform apply`) for automated AWS infrastructure creation.

---

## 🐳 Running with Docker (Recommended)

### 1. Configure Environment Variables
Create a `.env` file in the root directory:
```env
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=openai/gpt-oss-120b
```

### 2. Run with Docker Compose
```bash
docker compose up --build
```

Access the application in your browser at:
`http://localhost:8000`

---

## 💻 Running Locally (Without Docker)

### 1. Install Prerequisites
- **Python 3.10+**
- **Terraform CLI**: Download and place `terraform` in system PATH or root folder.

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Start Application Server
```bash
python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

---

## 🛠️ API Reference

- `GET /` - Web Interface Dashboard
- `POST /api/upload-pdf` - Extract text from uploaded PDF requirement files
- `POST /api/generate` - Generate formatted HCL code from requirement text
- `POST /api/deploy` - Stream live Terraform deployment logs line-by-line
- `GET /api/download` - Download generated `main.tf`
