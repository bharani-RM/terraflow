import fitz  # PyMuPDF
import io

def extract_text_from_pdf(pdf_file) -> str:
    """
    Extracts text from a given PDF file object.
    
    Args:
        pdf_file: A file-like object containing the PDF data.
        
    Returns:
        str: The extracted text from the PDF.
    """
    try:
        # Read the file-like object into a PyMuPDF Document
        pdf_bytes = pdf_file.read()
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        
        extracted_text = ""
        for page_num in range(len(doc)):
            page = doc.load_page(page_num)
            extracted_text += page.get_text()
            
        return extracted_text
    except Exception as e:
        raise Exception(f"Failed to process PDF: {str(e)}")
