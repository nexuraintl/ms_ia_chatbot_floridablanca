"""Paso 2 del pipeline: del OCR con geometria al corpus troceado por articulo.

Uso:  python tools/knowledge/build_corpus.py <geom.jsonl> <destino.json>

Produce el corpus que consume `server/knowledge`: un fragmento por articulo del
Estatuto (troceado si es muy largo), mas las tarifas y las preguntas curadas.

Cuatro procedencias con distinta confianza, declarada en cada fragmento:
  · curada         pregunta y respuesta redactada, de manual/preguntas.json
  · verificada     tablas matriciales transcritas a mano, de manual/tablas_verificadas.json
  · ocr_texto      prosa del articulado reconocida por lineas
  · ocr_geometria  tabla de tarifas de ICA, reconstruida por posicion de columna

Las tablas matriciales no se reconstruyen por OCR: se pierden y se parten celdas.
El detalle de las decisiones esta en docs/BASE_CONOCIMIENTO.md.
"""

import json
import os
import re
import sys
import unicodedata

# ── Limites de troceado ───────────────────────────────────────────────────────
MAX_CHUNK_CHARS = 2600
MIN_TAIL_CHARS = 400

# ── Bandas verticales de la plantilla del Concejo, en fraccion de alto ────────
HEADER_BAND = 0.125
FOOTER_BAND = 0.873

BOILERPLATE_PREFIXES = (
    "CONCEJO MUNICIPAL DE FLORIDABLANCA",
    "ACUERDOS MUNICIPALES",
    "Código: PSC-FR",
    "Codigo: PSC-FR",
    "Versión: 0",
    "Version: 0",
    "Fecha: 19/02/2024",
    "Correo Electrónico:",
    "Correo Electronico:",
    "Calle 5 No",
    "calle 5 No",
)
BOILERPLATE_PATTERNS = (
    re.compile(r"^P[áa]gina\s*\d*\s*(de\s*288)?$", re.I),
    re.compile(r"^\d+\s+de\s+288$"),
    re.compile(r"Nit\.?\s*804011758", re.I),
)

# El sello del municipio ("Solidarios, Comprometidos y Participativos") sale como
# ruido ilegible. Se descarta por baja legibilidad, no por lista de variantes.
LEGIBLE_CHARS = re.compile(r"[0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ \.,;:()\[\]/%\-–—°ºª\"'$+=&@]")

# ── Normalizacion de errores sistematicos del OCR ─────────────────────────────
OCR_FIXES = (
    (re.compile(r"\bI[\.\-]?J\\?T?T\b"), "UVT"),
    (re.compile(r"\bIJVT\b"), "UVT"),
    (re.compile(r"\bI\.JVT\b"), "UVT"),
    (re.compile(r"\buvr\b"), "UVT"),
    (re.compile(r"\bUV[TIL]\b"), "UVT"),
    (re.compile(r"\bde\s+O\s+a\s+(\d)"), r"de 0 a \1"),
    (re.compile(r"(\d)\s+,(\d)"), r"\1,\2"),
    (re.compile(r"[ \t]{2,}"), " "),
)

# Sensible a mayusculas a proposito: en el documento la cabecera de un articulo va
# siempre en versales, mientras que una referencia en el cuerpo va como "el articulo 60
# de la Ley 1430". Solo la vocal acentuada admite minuscula, porque el OCR la produce.
ARTICLE_RE = re.compile(r"^\s*ART[IÍí]C?U?L?O\s*\.?\s*(\d{1,4})\s*[\.\-–—:]?\s*(.*)$")

# Ventana de aceptacion del numero de articulo. El Estatuto numera de forma ascendente,
# asi que un salto grande delata una referencia a otra norma, no una cabecera.
ARTICLE_JUMP_LIMIT = 40

HEADING_RE = {
    "libro": re.compile(r"^\s*LIBRO\s+(PRIMERO|SEGUNDO|TERCERO|[IVX]+)\b(.*)$", re.I),
    "titulo": re.compile(r"^\s*T[IÍ]TULO\s+([IVXLC]+|PRIMERO|SEGUNDO)\b(.*)$", re.I),
    "capitulo": re.compile(r"^\s*CAP[IÍ]TULO\s+([IVXLC]+|PRELIMINAR|[0-9]+)\b(.*)$", re.I),
}

# Una linea toda en versales que sigue a un encabezado es su nombre.
def is_upper_line(text):
    letters = [c for c in text if c.isalpha()]
    if len(letters) < 3:
        return False
    return sum(1 for c in letters if c.isupper()) / len(letters) > 0.85

RANGE_TEMPLATES = (
    (re.compile(r"de\s*[O0]\s*a\s*1[.,]?\s*681"), "de 0 a 1.681 UVT"),
    (re.compile(r"de\s*1[.,]?\s*681.*?a\s*4[.,]?\s*201"), "de 1.681 a 4.201 UVT"),
    (re.compile(r"m[aá]s\s*de\s*4[.,]?\s*201"), "más de 4.201 UVT"),
)
TARIFA_RE = re.compile(r"^\d{1,2}(?:[.,]\d{1,2})?$")
CODE_RE = re.compile(r"^\d{2,4}$")
DIVISION_RE = re.compile(r"^DIVISION\s*[:.]?\s*(.*)$", re.I)


def strip_accents(text):
    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")


def is_boilerplate(text):
    stripped = text.strip()
    if not stripped:
        return True
    if stripped.startswith(BOILERPLATE_PREFIXES):
        return True
    return any(pattern.search(stripped) for pattern in BOILERPLATE_PATTERNS)


def is_illegible(text):
    """Ruido del sello: linea corta con demasiados caracteres no castellanos."""
    stripped = text.strip()
    if len(stripped) > 60:
        return False
    legible = len(LEGIBLE_CHARS.findall(stripped))
    return legible / max(1, len(stripped)) < 0.88


def normalize(text):
    for pattern, replacement in OCR_FIXES:
        text = pattern.sub(replacement, text)
    return text.strip()


def load_pages(path):
    pages = []
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            record = json.loads(raw)
            width, height = record["size"] or [1, 1]
            lines = []
            for line in record["lines"]:
                if not line["words"]:
                    continue
                first = line["words"][0]
                last = line["words"][-1]
                lines.append(
                    {
                        "text": line["text"],
                        "y": first["y"],
                        "x0": first["x"],
                        "x1": last["x"] + last["w"],
                        "xr": first["x"] / max(1, width),
                        "yr": first["y"] / max(1, height),
                    }
                )
            lines.sort(key=lambda item: item["y"])
            pages.append({"page": record["page"], "width": width, "height": height, "lines": lines})
    return pages


def content_lines(page):
    """Lineas de contenido: fuera de las bandas de cabecera y pie, y legibles."""
    out = []
    for line in page["lines"]:
        if line["yr"] < HEADER_BAND or line["yr"] > FOOTER_BAND:
            continue
        if is_boilerplate(line["text"]) or is_illegible(line["text"]):
            continue
        out.append(line)
    return out


def is_ica_table_page(lines):
    """La tabla de ICA tiene una columna de tarifas numericas al extremo derecho."""
    tarifas = sum(1 for l in lines if l["xr"] > 0.78 and TARIFA_RE.match(l["text"].strip()))
    return tarifas >= 3


# Tolerancia vertical para considerar que dos textos estan en la misma fila visual.
ROW_TOLERANCE_PX = 30

# Limite derecho de la columna de codigo. Amplio a proposito: la clasificacion la decide
# el patron del texto, no solo la posicion, porque el escaneo esta ligeramente inclinado
# y el borde de la columna de descripcion se desplaza a lo largo de la pagina.
CODE_COLUMN_LIMIT = 0.30
TARIFA_COLUMN_START = 0.78


def extract_ica_rows(pages, page_numbers):
    """Reconstruye la tabla de tarifas de ICA agrupando por fila visual."""
    rows = []
    current = {"division": "", "codigo": "", "actividad": ""}

    for page in pages:
        if page["page"] not in page_numbers:
            continue

        codes, tarifas, texts = [], [], []
        for line in content_lines(page):
            text = normalize(line["text"])
            if not text:
                continue
            if line["xr"] > TARIFA_COLUMN_START and TARIFA_RE.match(text):
                tarifas.append(line)
            elif line["xr"] < CODE_COLUMN_LIMIT and (CODE_RE.match(text) or DIVISION_RE.match(text)):
                codes.append(line)
            else:
                texts.append(line)

        # Un nombre de actividad puede ocupar varias lineas; se acumulan hasta el rango.
        pending = []
        for text_line in sorted(texts, key=lambda item: item["y"]):
            text = normalize(text_line["text"])
            rango = next((label for pattern, label in RANGE_TEMPLATES if pattern.search(text)), None)
            code = next(
                (c for c in codes if abs(c["y"] - text_line["y"]) <= ROW_TOLERANCE_PX), None
            )

            if rango is None:
                if code and DIVISION_RE.match(normalize(code["text"])):
                    current["division"] = text
                    pending = []
                    continue
                if code:
                    current["codigo"] = normalize(code["text"])
                    pending = [text]
                elif pending and is_upper_line(" ".join(pending)) and not is_upper_line(text):
                    # La linea en versales es el nombre del grupo CIIU; la que sigue en
                    # minusculas es la clase concreta y es la que describe la actividad.
                    pending = [text]
                else:
                    pending.append(text)
                current["actividad"] = " ".join(pending).strip()
                continue

            tarifa = next(
                (t for t in tarifas if abs(t["y"] - text_line["y"]) <= ROW_TOLERANCE_PX), None
            )
            rows.append(
                {
                    "codigo": current["codigo"],
                    "division": current["division"],
                    "actividad": current["actividad"],
                    "rango": rango,
                    "tarifa": normalize(tarifa["text"]) if tarifa else "",
                    "pagina_pdf": page["page"],
                }
            )
            pending = []
    return rows


# Techo legal de la tarifa de ICA (Ley 14 de 1983): ningun milaje llega a 12 por mil, asi
# que un valor de dos digitos por encima de ese techo es una coma que el OCR no vio.
ICA_TARIFA_CEILING = 12.0


def repair_ica_rows(rows):
    """Repone la coma decimal perdida por el OCR. No inventa tarifas ausentes."""
    repairs = []
    for row in rows:
        raw = row["tarifa"]
        if not re.fullmatch(r"\d{2}", raw):
            continue
        if float(raw) <= ICA_TARIFA_CEILING:
            continue
        fixed = f"{raw[0]},{raw[1]}"
        repairs.append(
            {
                "codigo": row["codigo"],
                "actividad": row["actividad"],
                "rango": row["rango"],
                "leido": raw,
                "corregido": fixed,
                "pagina_pdf": row["pagina_pdf"],
            }
        )
        row["tarifa"] = fixed
    return repairs


def audit_ica_rows(rows):
    """Avisos de consistencia: tarifa ausente o no creciente con el rango."""
    warnings = []
    order = {"de 0 a 1.681 UVT": 0, "de 1.681 a 4.201 UVT": 1, "más de 4.201 UVT": 2}
    by_activity = {}
    for row in rows:
        if not row["tarifa"]:
            warnings.append({"tipo": "tarifa_ausente", "codigo": row["codigo"],
                             "actividad": row["actividad"], "rango": row["rango"],
                             "pagina_pdf": row["pagina_pdf"]})
        key = (row["codigo"], row["actividad"])
        by_activity.setdefault(key, []).append(row)

    for (codigo, actividad), group in by_activity.items():
        graded = sorted(
            [r for r in group if r["tarifa"]],
            key=lambda r: order.get(r["rango"], 9),
        )
        values = []
        for row in graded:
            try:
                values.append(float(row["tarifa"].replace(",", ".")))
            except ValueError:
                warnings.append({"tipo": "tarifa_ilegible", "codigo": codigo,
                                 "actividad": actividad, "rango": row["rango"],
                                 "valor": row["tarifa"], "pagina_pdf": row["pagina_pdf"]})
        if len(values) >= 2 and any(b < a for a, b in zip(values, values[1:])):
            warnings.append({"tipo": "tarifa_no_creciente", "codigo": codigo,
                             "actividad": actividad, "valores": values,
                             "pagina_pdf": graded[0]["pagina_pdf"]})
    return warnings


# Longitud a partir de la cual una linea de una pagina de tabla se considera prosa y no
# celda: los parrafos del documento ocupan ~90 caracteres y los nombres de actividad ~70.
PROSE_LINE_CHARS = 80


def build_prose_stream(pages, table_pages):
    """Texto continuo de la prosa, con la pagina de origen por linea.

    En las paginas de tabla no se descarta todo: se conservan las cabeceras de articulo,
    los encabezados de libro/titulo/capitulo y los parrafos largos, que si son prosa.
    """
    stream = []
    for page in pages:
        is_table = page["page"] in table_pages
        for line in content_lines(page):
            text = normalize(line["text"])
            if not text:
                continue
            if is_table:
                is_structural = bool(ARTICLE_RE.match(text)) or any(
                    pat.match(text) for pat in HEADING_RE.values()
                )
                is_range = any(pattern.search(text) for pattern, _ in RANGE_TEMPLATES)
                if not is_structural and (is_range or len(text) < PROSE_LINE_CHARS):
                    continue
            stream.append({"text": text, "pagina_pdf": page["page"]})
    return stream


def extract_epigraph(rest):
    """Epigrafe = texto en versales hasta el primer punto. Puede no haberlo."""
    head = re.split(r"(?<=[a-zA-ZáéíóúñÁÉÍÓÚÑ])\.\s", rest, maxsplit=1)[0]
    head = head.rstrip(".:").strip()
    if head and is_upper_line(head) and len(head) <= 140:
        return head
    return ""


def split_articles(stream):
    """Corta el texto continuo en articulos, arrastrando la jerarquia vigente."""
    context = {"libro": "", "titulo": "", "capitulo": ""}
    articles = []
    rejected = []
    current = None
    last_number = 0
    index = 0

    while index < len(stream):
        item = stream[index]
        text = item["text"]

        heading_level = next((lvl for lvl, pat in HEADING_RE.items() if pat.match(text)), None)
        if heading_level:
            # El nombre del encabezado va en las lineas en versales que le siguen.
            name_parts = []
            probe = index + 1
            while probe < len(stream) and len(name_parts) < 3:
                candidate = stream[probe]["text"]
                if ARTICLE_RE.match(candidate) or not is_upper_line(candidate):
                    break
                if any(pat.match(candidate) for pat in HEADING_RE.values()):
                    break
                name_parts.append(candidate.strip())
                probe += 1
            label = " ".join([text.strip()] + name_parts)
            context[heading_level] = label
            if heading_level == "libro":
                context["titulo"] = context["capitulo"] = ""
            elif heading_level == "titulo":
                context["capitulo"] = ""
            index = probe
            continue

        match = ARTICLE_RE.match(text)
        if match:
            number = int(match.group(1))
            if last_number < number <= last_number + ARTICLE_JUMP_LIMIT:
                rest = match.group(2).strip()
                current = {
                    "articulo": number,
                    "epigrafe": extract_epigraph(rest),
                    "libro": context["libro"],
                    "titulo": context["titulo"],
                    "capitulo": context["capitulo"],
                    "pagina_inicio": item["pagina_pdf"],
                    "pagina_fin": item["pagina_pdf"],
                    "lineas": [text],
                }
                articles.append(current)
                last_number = number
                index += 1
                continue
            # Fuera de la ventana: es una referencia a otra norma. Queda registrada.
            rejected.append({"numero": number, "pagina_pdf": item["pagina_pdf"], "texto": text[:120]})

        if current:
            current["lineas"].append(text)
            current["pagina_fin"] = item["pagina_pdf"]
        index += 1

    return articles, rejected


def chunk_article(article):
    """Un fragmento por articulo; los muy largos se parten por parrafo."""
    body = " ".join(article["lineas"])
    body = re.sub(r"\s+", " ", body).strip()
    if len(body) <= MAX_CHUNK_CHARS:
        return [body]

    parts = []
    buffer = ""
    # Los parrafos del Estatuto empiezan por PARAGRAFO, letra, numeral o mayuscula.
    for piece in re.split(r"(?=PAR[AÁ]GRAFO|\b[a-z]\)\s|\b\d{1,2}\.\s)", body):
        if not piece.strip():
            continue
        if len(buffer) + len(piece) > MAX_CHUNK_CHARS and len(buffer) >= MIN_TAIL_CHARS:
            parts.append(buffer.strip())
            buffer = piece
        else:
            buffer += piece
    if buffer.strip():
        parts.append(buffer.strip())

    # Un parrafo unico puede seguir excediendo el tope: se corta por palabra.
    bounded = []
    for part in parts:
        while len(part) > MAX_CHUNK_CHARS:
            cut = part.rfind(" ", 0, MAX_CHUNK_CHARS)
            cut = cut if cut > MIN_TAIL_CHARS else MAX_CHUNK_CHARS
            bounded.append(part[:cut].strip())
            part = part[cut:].strip()
        if part:
            bounded.append(part)
    return bounded


MINOR_WORDS = {"de", "del", "la", "las", "el", "los", "y", "o", "a", "en", "con", "para", "por", "al", "sobre"}


def title_case_es(text):
    words = text.lower().split()
    return " ".join(
        word if index and word in MINOR_WORDS else word[:1].upper() + word[1:]
        for index, word in enumerate(words)
    )


def tema_from_label(label):
    """Tema legible a partir de un encabezado, para filtrar y para el Excel."""
    cleaned = re.sub(
        r"^\s*(CAP[IÍ]TULO|T[IÍ]TULO|LIBRO)\s+([IVXLC]+|PRELIMINAR|PRIMERO|SEGUNDO|\d+)\s*[\.\-–]?\s*",
        "",
        label or "",
        flags=re.I,
    )
    return title_case_es(cleaned.strip()) or "General"


def tema_from_context(article):
    return tema_from_label(article["capitulo"] or article["titulo"] or article["libro"])


def main(geom_path, dest_path):
    pages = load_pages(geom_path)
    table_pages = {p["page"] for p in pages if is_ica_table_page(content_lines(p))}

    ica_rows = extract_ica_rows(pages, table_pages)
    ica_repairs = repair_ica_rows(ica_rows)
    ica_warnings = audit_ica_rows(ica_rows)

    stream = build_prose_stream(pages, table_pages)
    articles, rejected = split_articles(stream)

    manual_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manual")
    manual_path = os.path.join(manual_dir, "tablas_verificadas.json")
    manual = json.load(open(manual_path, encoding="utf-8"))["tablas"] if os.path.exists(manual_path) else []

    faq_path = os.path.join(manual_dir, "preguntas.json")
    faqs = json.load(open(faq_path, encoding="utf-8"))["preguntas"] if os.path.exists(faq_path) else []

    chunks = []
    for article in articles:
        parts = chunk_article(article)
        for index, part in enumerate(parts):
            chunks.append(
                {
                    "id": f"art-{article['articulo']:03d}" + (f"-{index + 1}" if len(parts) > 1 else ""),
                    "tipo": "prosa",
                    "confianza": "ocr_texto",
                    "articulo": article["articulo"],
                    "epigrafe": article["epigrafe"],
                    "libro": article["libro"],
                    "titulo": article["titulo"],
                    "capitulo": article["capitulo"],
                    "tema": tema_from_context(article),
                    "pagina_pdf": article["pagina_inicio"],
                    "texto": part,
                }
            )

    for table in manual:
        header = " | ".join(table["columnas"])
        body = "\n".join(" | ".join(row) for row in table["filas"])
        nota = f"\n{table['nota']}" if table.get("nota") else ""
        chunks.append(
            {
                "id": table["id"],
                "tipo": "tabla",
                "confianza": "verificada",
                "articulo": table["articulo"],
                "epigrafe": table["titulo"],
                "libro": "LIBRO PRIMERO PARTE SUSTANTIVA",
                "titulo": "",
                "capitulo": table.get("capitulo", "CAPITULO I IMPUESTO PREDIAL UNIFICADO"),
                "tema": tema_from_label(table.get("capitulo", "CAPITULO I IMPUESTO PREDIAL UNIFICADO")),
                "pagina_pdf": table["pagina_pdf"],
                "texto": f"{table['titulo']} (tarifas expresadas {table['unidad']}).\n{header}\n{body}{nota}",
            }
        )

    # Preguntas curadas. Van primero en el corpus porque estan escritas en el lenguaje del
    # ciudadano y son las que deben ganar frente al articulado cuando la consulta coincide.
    for faq in faqs:
        keywords = " ".join(faq.get("palabras_clave", []))
        articulos = faq.get("articulos", [])
        cita = f" (Estatuto Tributario Municipal, artículo{'s' if len(articulos) > 1 else ''} {', '.join(str(a) for a in articulos)})" if articulos else ""
        chunks.append(
            {
                "id": f"faq-{faq['id']}",
                "tipo": "faq",
                "confianza": "curada",
                "articulo": articulos[0] if articulos else 0,
                "articulos": articulos,
                "epigrafe": faq["pregunta"],
                "libro": "",
                "titulo": "",
                "capitulo": "",
                "tema": faq.get("tema", "General"),
                "vigencia": faq.get("vigencia", "estable"),
                "palabras_clave": faq.get("palabras_clave", []),
                "pagina_pdf": 0,
                "texto": f"Pregunta frecuente: {faq['pregunta']}\nRespuesta oficial: {faq['respuesta']}{cita}\nTerminos relacionados: {keywords}",
            }
        )

    # La tabla de ICA se agrupa por actividad: un fragmento por actividad con sus rangos.
    grouped = {}
    for row in ica_rows:
        key = (row["codigo"], row["actividad"])
        grouped.setdefault(key, {"division": row["division"], "pagina_pdf": row["pagina_pdf"], "rangos": []})
        grouped[key]["rangos"].append((row["rango"], row["tarifa"]))

    for (codigo, actividad), data in grouped.items():
        if not actividad:
            continue
        detalle = "; ".join(f"{rango}: {tarifa or 'sin dato'} por mil" for rango, tarifa in data["rangos"])
        chunks.append(
            {
                "id": f"ica-{codigo or 'sc'}-{abs(hash(actividad)) % 10000:04d}",
                "tipo": "tarifa_ica",
                "confianza": "ocr_geometria",
                "articulo": 0,
                "epigrafe": f"Tarifa de ICA - {actividad}",
                "libro": "LIBRO PRIMERO PARTE SUSTANTIVA",
                "titulo": "",
                "capitulo": "CAPITULO II IMPUESTO DE INDUSTRIA Y COMERCIO",
                "tema": tema_from_label("CAPITULO II IMPUESTO DE INDUSTRIA Y COMERCIO"),
                "pagina_pdf": data["pagina_pdf"],
                "codigo_ciiu": codigo,
                "division": data["division"],
                "texto": f"Actividad {codigo}: {actividad}. Tarifa de industria y comercio segun ingresos brutos anuales: {detalle}.",
            }
        )

    corpus = {
        "fuente": {
            "documento": "Acuerdo Municipal No. 020 de 2026 - Estatuto Tributario del Municipio de Floridablanca",
            "fecha": "2026-07-31",
            "paginas": len(pages),
            "extraccion": "OCR nativo de Windows (es-ES) sobre PDF escaneado; tablas matriciales verificadas a mano",
        },
        "chunks": chunks,
    }

    os.makedirs(os.path.dirname(os.path.abspath(dest_path)), exist_ok=True)
    with open(dest_path, "w", encoding="utf-8") as out:
        json.dump(corpus, out, ensure_ascii=False, indent=1)

    report_path = os.path.join(os.path.dirname(os.path.abspath(dest_path)), "..", "..", "tools", "knowledge", "out")
    report_path = os.path.abspath(report_path)
    os.makedirs(report_path, exist_ok=True)
    with open(os.path.join(report_path, "tarifas_ica.json"), "w", encoding="utf-8") as out:
        json.dump({"filas": ica_rows, "avisos": ica_warnings, "correcciones": ica_repairs}, out, ensure_ascii=False, indent=1)

    numbers = sorted({a["articulo"] for a in articles})
    gaps = [n for n in range(1, numbers[-1] + 1) if n not in set(numbers)] if numbers else []
    with open(os.path.join(report_path, "informe_extraccion.json"), "w", encoding="utf-8") as out:
        json.dump(
            {
                "articulos_detectados": len(numbers),
                "ultimo_articulo": numbers[-1] if numbers else 0,
                "numeros_sin_detectar": gaps,
                "cabeceras_descartadas": rejected,
                "avisos_tarifas_ica": ica_warnings,
                "correcciones_tarifas_ica": ica_repairs,
            },
            out,
            ensure_ascii=False,
            indent=1,
        )

    prose = [c for c in chunks if c["tipo"] == "prosa"]
    print(f"paginas            : {len(pages)}")
    print(f"paginas de tabla   : {len(table_pages)}")
    print(f"articulos          : {len(numbers)} (ultimo: {numbers[-1] if numbers else 0})")
    print(f"numeros sin detectar: {len(gaps)} -> {gaps[:20]}")
    print(f"cabeceras descartadas: {len(rejected)}")
    print(f"fragmentos prosa   : {len(prose)}  (max {max(len(c['texto']) for c in prose)} chars)")
    print(f"fragmentos ICA     : {len([c for c in chunks if c['tipo'] == 'tarifa_ica'])}")
    print(f"tablas verificadas : {len(manual)}")
    print(f"preguntas curadas  : {len(faqs)}")
    print(f"filas ICA          : {len(ica_rows)}  correcciones: {len(ica_repairs)}  avisos: {len(ica_warnings)}")
    print(f"corpus             : {dest_path} ({os.path.getsize(dest_path)/1e6:.2f} MB)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
