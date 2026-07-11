import fitz  # PyMuPDF
import sys
import os

def pdf_to_images(pdf_path, output_dir, file_key):
    doc = fitz.open(pdf_path)
    os.makedirs(output_dir, exist_ok=True)
    for i, page in enumerate(doc):
        pix = page.get_pixmap(dpi=200)  # 200 DPI is sharp and optimized for mobile screens
        output_path = os.path.join(output_dir, f"{file_key}_page_{i+1}.png")
        pix.save(output_path)
    print(f"Converted {len(doc)} pages successfully")

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python pdf_converter.py <pdf_path> <output_dir> <file_key>")
        sys.exit(1)
    pdf_to_images(sys.argv[1], sys.argv[2], sys.argv[3])
