"""Paso 1 del pipeline: OCR del PDF escaneado con el motor nativo de Windows.

Uso:  python tools/knowledge/ocr_pdf.py <ruta.pdf> <destino.jsonl>

Emite un JSONL con una linea por pagina: {page, size, lines[{text, words[{t,x,y,w,h}]}]}.
Se guardan las coordenadas de cada palabra porque el documento contiene tablas de
tarifas cuyas columnas solo pueden reconstruirse por posicion.

Requisitos: pypdf, Pillow, winsdk. El idioma es-ES debe estar disponible en Windows.
"""

import asyncio
import io
import json
import os
import sys
import time

from PIL import Image
from pypdf import PdfReader
from winsdk.windows.globalization import Language
from winsdk.windows.graphics.imaging import BitmapDecoder
from winsdk.windows.media.ocr import OcrEngine
from winsdk.windows.storage.streams import DataWriter, InMemoryRandomAccessStream

OCR_LANGUAGE = "es-ES"


def make_engine(tag=OCR_LANGUAGE):
    engine = OcrEngine.try_create_from_language(Language(tag))
    if engine is None:
        available = [lang.language_tag for lang in OcrEngine.available_recognizer_languages]
        raise RuntimeError(f"sin motor OCR para {tag}; disponibles: {available}")
    return engine


async def _recognize(png_bytes, engine):
    stream = InMemoryRandomAccessStream()
    writer = DataWriter(stream.get_output_stream_at(0))
    writer.write_bytes(png_bytes)
    await writer.store_async()
    await writer.flush_async()
    stream.seek(0)
    decoder = await BitmapDecoder.create_async(stream)
    bitmap = await decoder.get_software_bitmap_async()
    result = await engine.recognize_async(bitmap)
    lines = []
    for line in result.lines:
        words = [
            {
                "t": w.text,
                "x": w.bounding_rect.x,
                "y": w.bounding_rect.y,
                "w": w.bounding_rect.width,
                "h": w.bounding_rect.height,
            }
            for w in line.words
        ]
        lines.append({"text": line.text, "words": words})
    return lines


def ocr_image(img, engine):
    if img.mode not in ("L", "RGB"):
        img = img.convert("L")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return asyncio.run(_recognize(buf.getvalue(), engine))


def main(pdf_path, dest_path):
    engine = make_engine()
    reader = PdfReader(pdf_path)
    total = len(reader.pages)
    os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
    started = time.time()
    failures = []

    with open(dest_path, "w", encoding="utf-8") as out:
        for index in range(total):
            try:
                images = reader.pages[index].images
                if not images:
                    raise ValueError("la pagina no contiene imagen")
                img = Image.open(io.BytesIO(images[0].data))
                record = {"page": index + 1, "size": list(img.size), "lines": ocr_image(img, engine)}
            except Exception as exc:  # una pagina ilegible no debe abortar el lote
                failures.append((index + 1, f"{type(exc).__name__}: {exc}"))
                record = {"page": index + 1, "size": [0, 0], "lines": []}
            out.write(json.dumps(record, ensure_ascii=False) + "\n")
            if (index + 1) % 50 == 0:
                print(f"  {index + 1}/{total}  {time.time() - started:.0f}s", flush=True)

    print(f"OCR de {total} paginas en {time.time() - started:.0f}s -> {dest_path}")
    for page, why in failures:
        print(f"  FALLO pagina {page}: {why}")
    return 1 if failures else 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
