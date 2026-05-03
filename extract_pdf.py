import fitz # PyMuPDF
doc = fitz.open("Mi carta (1).pdf")
text = ""
for page in doc:
    text += page.get_text()
with open("extracted_menu.txt", "w", encoding="utf-8") as f:
    f.write(text)
print("Extracted menu to extracted_menu.txt. Length:", len(text))
