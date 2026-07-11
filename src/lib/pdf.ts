import { exec } from "child_process";
import path from "path";

export function convertPdfToImages(pdfPath: string, outputDir: string, fileKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, "pdf_converter.py");
    exec(`python "${scriptPath}" "${pdfPath}" "${outputDir}" "${fileKey}"`, (error, stdout, stderr) => {
      if (error) {
        console.error("PDF conversion error:", stderr || error.message);
        reject(error);
      } else {
        console.log("PDF conversion success:", stdout.trim());
        resolve();
      }
    });
  });
}
