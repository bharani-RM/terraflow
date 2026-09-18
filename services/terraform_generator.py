import re
from groq import Groq
from config.settings import GROQ_API_KEY, GROQ_MODEL
from models.schemas import TerraformRequirements
from prompts.terraform_prompt import TERRAFORM_SYSTEM_PROMPT, build_terraform_user_prompt

# Setup Groq client
client = Groq(api_key=GROQ_API_KEY)

def extract_hcl(response_text: str) -> str:
    """
    Cleans up any markdown fences from the LLM response to get pure HCL.
    """
    # Remove markdown code fences if present
    match = re.search(r'```(?:hcl|terraform)?\s*(.*?)\s*```', response_text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return response_text.strip()

def generate_terraform(requirements: TerraformRequirements, access_key: str = "", secret_key: str = "") -> str:
    """
    Generates Terraform code from structured requirements.
    """
    try:
        user_prompt = build_terraform_user_prompt(requirements, access_key=access_key, secret_key=secret_key)
        
        response = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": TERRAFORM_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt}
            ],
            temperature=0.2
        )
        
        raw_code = response.choices[0].message.content
        return extract_hcl(raw_code)
        
    except Exception as e:
        raise Exception(f"Failed to generate Terraform code: {str(e)}")

def correct_terraform(requirements: TerraformRequirements, terraform_code: str, error_message: str) -> str:
    """
    Uses the LLM to correct Terraform code based on validation errors.
    """
    from prompts.terraform_prompt import TERRAFORM_CORRECTION_PROMPT
    try:
        user_prompt = TERRAFORM_CORRECTION_PROMPT.format(
            requirements=requirements.model_dump_json(indent=2),
            terraform_code=terraform_code,
            error_message=error_message
        )
        
        response = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "user", "content": user_prompt}
            ],
            temperature=0.2
        )
        
        raw_code = response.choices[0].message.content
        return extract_hcl(raw_code)
        
    except Exception as e:
        raise Exception(f"Failed to correct Terraform code: {str(e)}")
