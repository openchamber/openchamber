import { unzip, unzipSync, type UnzipFileInfo, type Unzipped } from "fflate"

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
const MAX_ENTRY_BYTES = 25 * 1024 * 1024
const MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 5_000
const MAX_EMBEDDED_IMAGES = 50
const MAX_EMBEDDED_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_EMBEDDED_IMAGES_BYTES = 40 * 1024 * 1024
const MAX_EXTRACTED_TEXT_CHARS = 500_000
const MAX_ODF_SPACES_PER_ELEMENT = 100
const MAX_ODS_REPEAT = 1_000
const MAX_ODS_COLUMNS = 1_024
const MAX_WORKBOOK_COLUMNS = 256
// Excel's own limit. A longer code is a crafted file, and the scan below is quadratic on it.
const MAX_NUMBER_FORMAT_CHARS = 255
const TEXT_TRUNCATION_NOTICE = "\n\n[Document text truncated by OpenChamber]\n"

const OFFICE_EXTENSIONS = new Set(["docx", "pptx", "xlsx", "odt", "odp", "ods"])
const IMAGE_MIMES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
])

type Relationship = { target: string; type: string }
type Relationships = Map<string, Relationship>

type ExtractedDocumentAttachments = {
  textFile: File
  images: File[]
}

const extensionOf = (name: string): string => {
  const index = name.lastIndexOf(".")
  return index === -1 ? "" : name.slice(index + 1).toLowerCase()
}

const basenameWithoutExtension = (name: string): string => {
  const basename = name.replace(/\\/g, "/").split("/").pop() || "document"
  const index = basename.lastIndexOf(".")
  return (index > 0 ? basename.slice(0, index) : basename).replace(/[^a-zA-Z0-9._-]+/g, "-") || "document"
}

const normalizeArchivePath = (path: string): string | undefined => {
  const segments: string[] = []
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join("/")
}

const resolveArchivePath = (sourcePath: string, target: string): string | undefined => {
  if (target.startsWith("/")) return normalizeArchivePath(target.slice(1))
  const sourceDirectory = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1) : ""
  return normalizeArchivePath(`${sourceDirectory}${target}`)
}

const relationshipsPath = (sourcePath: string): string => {
  const index = sourcePath.lastIndexOf("/")
  const directory = index === -1 ? "" : sourcePath.slice(0, index + 1)
  const filename = sourcePath.slice(index + 1)
  return `${directory}_rels/${filename}.rels`
}

const decodeXmlCodePoint = (code: string, radix: number): string => {
  const value = Number.parseInt(code, radix)
  if (value < 0 || value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF)) return "�"
  return String.fromCodePoint(value)
}

const decodeXml = (value: string): string => value
  .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => decodeXmlCodePoint(code, 16))
  .replace(/&#([0-9]+);/g, (_, code: string) => decodeXmlCodePoint(code, 10))
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, "&")

const attribute = (tag: string, name: string): string | undefined => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = tag.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"))
  return decodeXml(match?.[1] ?? match?.[2] ?? "") || undefined
}

const tagBlocks = (xml: string, tag: string): string[] => {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return Array.from(xml.matchAll(new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}>`, "gi")), (match) => match[0])
}

// Unlike tagBlocks, keeps self-closing elements on their own: an empty styled
// cell must not swallow the next cell, and `table:table-row` stops matching
// `table:table-row-group`.
const elements = (source: string, tag: string): string[] => {
  const pattern = new RegExp(`<${tag}(?=[\\s/>])[^>]*?\\/>|<${tag}(?=[\\s/>])[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi")
  return Array.from(source.matchAll(pattern), (match) => match[0])
}

const textDecoder = new TextDecoder()
const xml = (archive: Unzipped, path: string): string => {
  const bytes = archive[path]
  return bytes ? textDecoder.decode(bytes) : ""
}

const parseRelationships = (archive: Unzipped, sourcePath: string): Relationships => {
  const result: Relationships = new Map()
  const source = xml(archive, relationshipsPath(sourcePath))
  for (const match of source.matchAll(/<Relationship\b[^>]*\/?\s*>/gi)) {
    const id = attribute(match[0], "Id")
    const target = attribute(match[0], "Target")
    if (!id || !target) continue
    result.set(id, { target, type: attribute(match[0], "Type") ?? "" })
  }
  return result
}

const isControlCharacter = (character: string): boolean => {
  const code = character.charCodeAt(0)
  return code <= 0x1F || code === 0x7F
}

const hasControlCharacters = (value: string): boolean => Array.from(value).some(isControlCharacter)

const embeddedImageLabel = (path: string): string => {
  const basename = path.replace(/\\/g, "/").split("/").pop() || "embedded image"
  return Array.from(basename.slice(0, 200), (character) => {
    if (character === "[" || character === "]") return "_"
    return isControlCharacter(character) ? "_" : character
  }).join("")
}

const hasBytes = (bytes: Uint8Array, expected: number[]): boolean => expected.every((value, index) => bytes[index] === value)

const hasAscii = (bytes: Uint8Array, offset: number, expected: string): boolean => {
  if (bytes.byteLength < offset + expected.length) return false
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false
  }
  return true
}

const hasValidImageSignature = (bytes: Uint8Array, extension: string): boolean => {
  switch (extension) {
    case "png":
      return hasBytes(bytes, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    case "jpg":
    case "jpeg":
      return hasBytes(bytes, [0xFF, 0xD8, 0xFF])
    case "gif":
      return hasAscii(bytes, 0, "GIF87a") || hasAscii(bytes, 0, "GIF89a")
    case "webp":
      return hasAscii(bytes, 0, "RIFF") && hasAscii(bytes, 8, "WEBP")
    default:
      return false
  }
}

class EmbeddedImages {
  private readonly files: File[] = []
  private readonly filenames = new Map<string, string>()
  private count = 0
  private imageBytes = 0
  private readonly reservedFilenames: Set<string>

  constructor(
    private readonly archive: Unzipped,
    private readonly documentName: string,
    reservedFilenames: Iterable<string>,
  ) {
    this.reservedFilenames = new Set(Array.from(reservedFilenames, (filename) => filename.toLowerCase()))
  }

  citation(path: string | undefined): string {
    if (!path) return "[Embedded image reference could not be resolved]"
    const normalized = normalizeArchivePath(path)
    if (!normalized) return "[Unsafe embedded image path omitted]"
    const existing = this.filenames.get(normalized)
    if (existing) return `[${existing}]`

    const bytes = this.archive[normalized]
    const extension = extensionOf(normalized)
    const mime = IMAGE_MIMES.get(extension)
    const label = embeddedImageLabel(normalized)
    if (!bytes || !mime) return `[Unsupported embedded image omitted: ${label}]`
    if (!hasValidImageSignature(bytes, extension)) return `[Invalid embedded image omitted: ${label}]`
    if (
      this.files.length >= MAX_EMBEDDED_IMAGES
      || bytes.byteLength > MAX_EMBEDDED_IMAGE_BYTES
      || this.imageBytes + bytes.byteLength > MAX_EMBEDDED_IMAGES_BYTES
    ) {
      return `[Embedded image omitted by attachment limits: ${label}]`
    }

    const outputExtension = extension === "jpeg" ? "jpg" : extension
    let filename: string
    do {
      this.count += 1
      filename = `${basenameWithoutExtension(this.documentName)}-image-${this.count}.${outputExtension}`
    } while (this.reservedFilenames.has(filename.toLowerCase()))
    this.reservedFilenames.add(filename.toLowerCase())
    this.filenames.set(normalized, filename)
    this.files.push(new File([bytes], filename, { type: mime }))
    this.imageBytes += bytes.byteLength
    return `[${filename}]`
  }

  all(): File[] {
    return this.files
  }
}

const relationshipTarget = (sourcePath: string, relationships: Relationships, id: string | undefined): string | undefined => {
  if (!id) return
  const relationship = relationships.get(id)
  return relationship ? resolveArchivePath(sourcePath, relationship.target) : undefined
}

const inlineText = (
  block: string,
  sourcePath: string,
  relationships: Relationships,
  images: EmbeddedImages,
): string => {
  const pieces: string[] = []
  const tokenPattern = /<(?:w:t|a:t|text:span)\b[^>]*>([\s\S]*?)<\/(?:w:t|a:t|text:span)>|<(?:w:tab|text:tab)\b[^>]*\/?>|<(?:w:br|a:br|text:line-break)\b[^>]*\/?>|<(?:a:blip|v:imagedata)\b[^>]*>|<draw:image\b[^>]*>/gi
  for (const match of block.matchAll(tokenPattern)) {
    if (match[1] !== undefined) {
      pieces.push(decodeXml(match[1]).replace(/<[^>]+>/g, ""))
      continue
    }
    if (/tab/i.test(match[0])) {
      pieces.push("\t")
      continue
    }
    if (/br|line-break/i.test(match[0])) {
      pieces.push("\n")
      continue
    }
    const relationshipId = attribute(match[0], "r:embed") ?? attribute(match[0], "r:id")
    const directPath = attribute(match[0], "xlink:href")
    const target = directPath
      ? resolveArchivePath(sourcePath, directPath)
      : relationshipTarget(sourcePath, relationships, relationshipId)
    pieces.push(`\n${images.citation(target)}\n`)
  }
  return pieces.join("").replace(/[ \t]+\n/g, "\n").trim()
}

const paragraphs = (
  source: string,
  paragraphTag: string,
  sourcePath: string,
  relationships: Relationships,
  images: EmbeddedImages,
): string[] => tagBlocks(source, paragraphTag)
  .map((block) => inlineText(block, sourcePath, relationships, images))
  .filter(Boolean)

const extractDocx = (archive: Unzipped, images: EmbeddedImages): string | undefined => {
  const documentPath = "word/document.xml"
  const documentXml = xml(archive, documentPath)
  if (!documentXml) return
  const sections = ["# Document", ...paragraphs(documentXml, "w:p", documentPath, parseRelationships(archive, documentPath), images)]

  const extras = Object.keys(archive)
    .filter((path) => /^word\/(?:header|footer)\d+\.xml$/i.test(path))
    .sort()
  for (const path of extras) {
    const content = paragraphs(xml(archive, path), "w:p", path, parseRelationships(archive, path), images)
    if (content.length > 0) sections.push(`## ${path.includes("header") ? "Header" : "Footer"}`, ...content)
  }
  return `${sections.join("\n\n")}\n`
}

const numberedPaths = (archive: Unzipped, pattern: RegExp): string[] => Object.keys(archive)
  .filter((path) => pattern.test(path))
  .sort((left, right) => {
    const leftNumber = Number(left.match(/(\d+)(?=\.xml$)/)?.[1] ?? 0)
    const rightNumber = Number(right.match(/(\d+)(?=\.xml$)/)?.[1] ?? 0)
    return leftNumber - rightNumber
  })

const extractPptx = (archive: Unzipped, images: EmbeddedImages): string | undefined => {
  const slidePaths = numberedPaths(archive, /^ppt\/slides\/slide\d+\.xml$/i)
  if (slidePaths.length === 0) return
  const sections: string[] = ["# Presentation"]

  slidePaths.forEach((slidePath, index) => {
    const relationships = parseRelationships(archive, slidePath)
    const content = Array.from(
      xml(archive, slidePath).matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p>|<p:pic\b[^>]*>[\s\S]*?<\/p:pic>/gi),
      (match) => inlineText(match[0], slidePath, relationships, images),
    ).filter(Boolean)
    sections.push(`## Slide ${index + 1}`, ...(content.length > 0 ? content : ["[Empty slide]"]))

    const notesRelationship = Array.from(relationships.values()).find((relationship) => relationship.type.endsWith("/notesSlide"))
    const notesPath = notesRelationship ? resolveArchivePath(slidePath, notesRelationship.target) : undefined
    if (!notesPath) return
    const notes = paragraphs(xml(archive, notesPath), "a:p", notesPath, parseRelationships(archive, notesPath), images)
    if (notes.length > 0) sections.push(`### Slide ${index + 1} notes`, ...notes)
  })
  return `${sections.join("\n\n")}\n`
}

export const columnName = (index: number): string => {
  let value = index + 1
  let result = ""
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

const columnIndex = (name: string): number => {
  let result = 0
  for (const character of name.toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64
  return result - 1
}

const tsvValue = (value: string): string => {
  if (!/[\t\r\n"]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

type NumberFormat = (value: number) => string

const BUILT_IN_NUMBER_FORMATS = new Map<number, string>([
  [1, "0"], [2, "0.00"], [3, "#,##0"], [4, "#,##0.00"], [9, "0%"], [10, "0.00%"],
  [14, "yyyy-mm-dd"], [15, "d-mmm-yy"], [16, "d-mmm"], [17, "mmm-yy"],
  [18, "h:mm AM/PM"], [19, "h:mm:ss AM/PM"], [20, "h:mm"], [21, "h:mm:ss"], [22, "yyyy-mm-dd h:mm"],
  [37, "#,##0"], [38, "#,##0"], [39, "#,##0.00"], [40, "#,##0.00"],
  [45, "mm:ss"], [46, "[h]:mm:ss"], [47, "mm:ss"], [49, "@"],
])

// Serial day 25569 is 1970-01-01. Serials below 60 sit before the leap day
// Excel invented in 1900, so they are one day off from the rest.
const formatDateSerial = (serial: number, date1904: boolean, hasDate: boolean, hasTime: boolean, hasSeconds: boolean): string | undefined => {
  const days = date1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial
  const date = new Date(Math.round((days - 25569) * 86_400_000))
  if (serial < 0 || Number.isNaN(date.getTime())) return
  const [day, time] = date.toISOString().slice(0, 19).split("T")
  return [hasDate ? day : "", hasTime ? time.slice(0, hasSeconds ? 8 : 5) : ""].filter(Boolean).join(" ")
}

const formatElapsedHours = (value: number): string => {
  const seconds = Math.round(value * 86_400)
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

/**
 * What a cell's format code changes in the shown value. A number only follows
 * a plain digit pattern with optional decimals; anything richer, such as
 * scientific or fraction notation, keeps the stored value, because rounding it
 * through the wrong pattern would show a different number.
 */
const numberFormatter = (code: string, date1904: boolean): NumberFormat | undefined => {
  if (code.length > MAX_NUMBER_FORMAT_CHARS) return
  if (/\[h+\]/i.test(code)) return formatElapsedHours
  if (/\[[ms]+\]/i.test(code)) return
  const section = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "").split(";")[0] ?? ""
  if (/^(?:general|@)?$/i.test(section.trim())) return
  const hasTime = /[hs]/i.test(section)
  const hasDate = /[yd]/i.test(section) || (/m/i.test(section) && !hasTime)
  if (hasDate || hasTime) {
    const hasSeconds = /s/i.test(section)
    return (value) => formatDateSerial(value, date1904, hasDate, hasTime, hasSeconds) ?? String(value)
  }
  const digits = section.match(/^[^0#?]*[0#?,]+(?:\.(0+))?[^0#?]*$/)
  if (!digits) return
  const decimals = digits[1]?.length ?? 0
  if (section.includes("%")) return (value) => `${(value * 100).toFixed(decimals)}%`
  return (value) => value.toFixed(decimals)
}

/** One format per entry of `cellXfs`, which a cell's `s` attribute indexes. */
const spreadsheetNumberFormats = (archive: Unzipped, workbookXml: string): Array<NumberFormat | undefined> => {
  const stylesXml = xml(archive, "xl/styles.xml")
  const date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/i.test(workbookXml)
  const codes = new Map(BUILT_IN_NUMBER_FORMATS)
  for (const format of elements(stylesXml, "numFmt")) {
    const id = Number(attribute(format, "numFmtId"))
    const code = attribute(format, "formatCode")
    if (Number.isInteger(id) && code) codes.set(id, code)
  }
  return elements(tagBlocks(stylesXml, "cellXfs")[0] ?? "", "xf").map((style) => {
    const code = codes.get(Number(attribute(style, "numFmtId")))
    return code ? numberFormatter(code, date1904) : undefined
  })
}

// Decimals in the file carry binary noise: 0.1 + 0.2 is stored as 0.30000000000000004.
const numericCellValue = (raw: string, format: NumberFormat | undefined): string => {
  const value = Number(raw)
  if (raw === "" || !Number.isFinite(value)) return raw
  if (format) return format(value)
  return /[.e]/i.test(raw) ? String(Number(value.toPrecision(15))) : raw
}

const cellValue = (cell: string, sharedStrings: string[], numberFormats: Array<NumberFormat | undefined>): string => {
  const tag = cell.match(/^<c\b[^>]*>/i)?.[0] ?? ""
  const type = attribute(tag, "t")
  if (type === "inlineStr") {
    return Array.from(cell.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi), (match) => decodeXml(match[1]).replace(/<[^>]+>/g, "")).join("")
  }
  const value = cell.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? ""
  if (type === "s") return sharedStrings[Number(value)] ?? ""
  if (type === "b") return value === "1" ? "TRUE" : "FALSE"
  if (type && type !== "n") return decodeXml(value)
  return numericCellValue(value, numberFormats[Number(attribute(tag, "s"))])
}

type SpreadsheetCell = {
  reference: string
  column: number
  row: number
  value: string
}

type SpreadsheetRow = {
  cells: SpreadsheetCell[]
  firstColumn: number
  lastColumn: number
  row: number
}

const isDenseSpreadsheetRow = (row: SpreadsheetRow): boolean => {
  const width = row.lastColumn - row.firstColumn + 1
  return width <= Math.max(32, row.cells.length * 4)
}

const serializeDenseSpreadsheetRow = (row: SpreadsheetRow): string => {
  const valuesByColumn = new Map(row.cells.map((cell) => [cell.column, cell.value]))
  return Array.from(
    { length: row.lastColumn - row.firstColumn + 1 },
    (_, offset) => tsvValue(valuesByColumn.get(row.firstColumn + offset) ?? ""),
  ).join("\t")
}

const spreadsheetRows = (
  worksheet: string,
  sharedStrings: string[],
  numberFormats: Array<NumberFormat | undefined>,
): SpreadsheetRow[] => {
  const rows: SpreadsheetRow[] = []
  for (const rowXml of elements(worksheet, "row")) {
    const cells: SpreadsheetCell[] = []
    for (const cell of elements(rowXml, "c")) {
      const tag = cell.match(/^<c\b[^>]*>/i)?.[0] ?? ""
      const reference = attribute(tag, "r")
      const coordinates = reference?.match(/^([a-z]+)([1-9]\d*)$/i)
      const value = cellValue(cell, sharedStrings, numberFormats)
      if (!reference || !coordinates || !value) continue
      cells.push({
        reference,
        column: columnIndex(coordinates[1]),
        row: Number(coordinates[2]),
        value,
      })
    }
    cells.sort((left, right) => left.column - right.column)
    const first = cells[0]
    const last = cells.at(-1)
    if (!first || !last) continue
    rows.push({ cells, firstColumn: first.column, lastColumn: last.column, row: first.row })
  }
  return rows
}

const serializeSpreadsheetRows = (rows: SpreadsheetRow[]): string[] => {
  const sections: string[] = []
  let denseBlock: SpreadsheetRow[] = []

  const flushDenseBlock = () => {
    const first = denseBlock[0]
    const last = denseBlock.at(-1)
    if (!first || !last) return
    sections.push([
      `Range: ${columnName(first.firstColumn)}${first.row}:${columnName(first.lastColumn)}${last.row}`,
      ...denseBlock.map(serializeDenseSpreadsheetRow),
    ].join("\n"))
    denseBlock = []
  }

  for (const row of rows) {
    const previous = denseBlock.at(-1)
    if (!isDenseSpreadsheetRow(row)) {
      flushDenseBlock()
      sections.push(`Cells: ${row.cells.map((cell) => `${cell.reference}\t${tsvValue(cell.value)}`).join(" | ")}`)
      continue
    }
    if (
      previous
      && (row.row !== previous.row + 1
        || row.firstColumn !== previous.firstColumn
        || row.lastColumn !== previous.lastColumn)
    ) {
      flushDenseBlock()
    }
    denseBlock.push(row)
  }
  flushDenseBlock()
  return sections
}

const drawingCitations = (
  archive: Unzipped,
  worksheetPath: string,
  images: EmbeddedImages,
): string[] => {
  const worksheetXml = xml(archive, worksheetPath)
  const worksheetRelationships = parseRelationships(archive, worksheetPath)
  const output: string[] = []
  for (const drawing of worksheetXml.matchAll(/<drawing\b[^>]*r:id=(?:"([^"]+)"|'([^']+)')[^>]*\/?\s*>/gi)) {
    const drawingPath = relationshipTarget(worksheetPath, worksheetRelationships, drawing[1] ?? drawing[2])
    if (!drawingPath) continue
    const drawingXml = xml(archive, drawingPath)
    const drawingRelationships = parseRelationships(archive, drawingPath)
    for (const anchor of drawingXml.matchAll(/<xdr:(?:oneCellAnchor|twoCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:(?:oneCellAnchor|twoCellAnchor)>/gi)) {
      const content = anchor[1]
      const column = Number(content.match(/<xdr:col>(\d+)<\/xdr:col>/i)?.[1] ?? 0)
      const row = Number(content.match(/<xdr:row>(\d+)<\/xdr:row>/i)?.[1] ?? 0)
      const imageId = content.match(/<a:blip\b[^>]*r:embed=(?:"([^"]+)"|'([^']+)')[^>]*>/i)
      const target = relationshipTarget(drawingPath, drawingRelationships, imageId?.[1] ?? imageId?.[2])
      output.push(`Image at ${columnName(column)}${row + 1}: ${images.citation(target)}`)
    }
  }
  return output
}

type XlsxSheet = { name: string; path: string; rows: SpreadsheetRow[] }

const xlsxSheets = (archive: Unzipped): XlsxSheet[] | undefined => {
  const workbookPath = "xl/workbook.xml"
  const workbookXml = xml(archive, workbookPath)
  if (!workbookXml) return
  const workbookRelationships = parseRelationships(archive, workbookPath)
  const sharedStrings = tagBlocks(xml(archive, "xl/sharedStrings.xml"), "si")
    .map((item) => Array.from(item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi), (match) => decodeXml(match[1]).replace(/<[^>]+>/g, "")).join(""))
  const numberFormats = spreadsheetNumberFormats(archive, workbookXml)
  const sheets: XlsxSheet[] = []

  for (const sheet of workbookXml.matchAll(/<sheet\b[^>]*\/?\s*>/gi)) {
    const path = relationshipTarget(workbookPath, workbookRelationships, attribute(sheet[0], "r:id"))
    if (!path) continue
    sheets.push({
      name: attribute(sheet[0], "name") ?? "Sheet",
      path,
      rows: spreadsheetRows(xml(archive, path), sharedStrings, numberFormats),
    })
  }
  return sheets
}

const extractXlsx = (archive: Unzipped, images: EmbeddedImages): string | undefined => {
  const sheets = xlsxSheets(archive)
  if (!sheets) return
  const sections: string[] = ["# Workbook"]
  for (const sheet of sheets) {
    const rows = serializeSpreadsheetRows(sheet.rows)
    sections.push(`## Sheet: ${sheet.name}`, ...(rows.length > 0 ? rows : ["[Empty sheet]"]), ...drawingCitations(archive, sheet.path, images))
  }
  return `${sections.join("\n\n")}\n`
}

const expandOdfSpaces = (tag: string): string => {
  const rawCount = attribute(tag, "text:c")
  if (!rawCount) return " "

  const count = Number(rawCount)
  if (Number.isSafeInteger(count) && count > 0 && count <= MAX_ODF_SPACES_PER_ELEMENT) return " ".repeat(count)

  const omitted = Number.isSafeInteger(count) && count > MAX_ODF_SPACES_PER_ELEMENT
    ? `${count - MAX_ODF_SPACES_PER_ELEMENT} additional spaces omitted`
    : "Additional spaces omitted"
  return `${" ".repeat(MAX_ODF_SPACES_PER_ELEMENT)}[${omitted}]`
}

const odfInlineText = (source: string, sourcePath: string, images: EmbeddedImages): string => source
    .replace(/<draw:image\b[^>]*>/gi, (tag) => {
      const target = resolveArchivePath(sourcePath, attribute(tag, "xlink:href") ?? "")
      return `\n${images.citation(target)}\n`
    })
    .replace(/<text:tab\b[^>]*\/?\s*>/gi, "\t")
    .replace(/<text:line-break\b[^>]*\/?\s*>/gi, "\n")
    .replace(/<text:s\b[^>]*\/?\s*>/gi, expandOdfSpaces)
    .replace(/<[^>]+>/g, "")

const odfContent = (source: string, sourcePath: string, images: EmbeddedImages): string[] => {
  const output: string[] = []
  const contentPattern = /<text:(p|h)\b[^>]*>[\s\S]*?<\/text:\1>|<draw:image\b[^>]*>/gi
  for (const match of source.matchAll(contentPattern)) {
    const content = /^<draw:image\b/i.test(match[0])
      ? images.citation(resolveArchivePath(sourcePath, attribute(match[0], "xlink:href") ?? ""))
      : decodeXml(odfInlineText(match[0], sourcePath, images)).replace(/[ \t]+\n/g, "\n").trim()
    if (content) output.push(content)
  }
  return output
}

const extractOdt = (archive: Unzipped, images: EmbeddedImages): string | undefined => {
  const contentPath = "content.xml"
  const content = xml(archive, contentPath)
  if (!content) return
  return `${["# Document", ...odfContent(content, contentPath, images)].join("\n\n")}\n`
}

const extractOdp = (archive: Unzipped, images: EmbeddedImages): string | undefined => {
  const contentPath = "content.xml"
  const content = xml(archive, contentPath)
  if (!content) return
  const sections = ["# Presentation"]
  const pages = tagBlocks(content, "draw:page")
  pages.forEach((page, index) => {
    const openTag = page.match(/^<draw:page\b[^>]*>/i)?.[0] ?? ""
    const name = attribute(openTag, "draw:name") ?? String(index + 1)
    sections.push(`## Slide: ${name}`, ...odfContent(page, contentPath, images))
  })
  return `${sections.join("\n\n")}\n`
}

const repeatCount = (tag: string, name: string): number => {
  const count = Number(attribute(tag, name))
  return Number.isSafeInteger(count) && count > 0 ? count : 1
}

/**
 * ODF stores runs of equal cells and rows once with a repeat count, and pads
 * every sheet to the format's full size with such runs, so a repeat is expanded
 * only when it holds a value and only up to a bound.
 */
const odsRows = (table: string, cellText: (cell: string) => string) => {
  const rows: SpreadsheetRow[] = []
  let omittedRows = 0
  let rowNumber = 1
  for (const row of elements(table, "table:table-row")) {
    const rowRepeat = repeatCount(row, "table:number-rows-repeated")
    const cells: SpreadsheetCell[] = []
    let column = 0
    for (const cell of elements(row, "table:(?:covered-)?table-cell")) {
      if (column >= MAX_ODS_COLUMNS) break
      const columnRepeat = repeatCount(cell, "table:number-columns-repeated")
      const value = cellText(cell)
      if (value) {
        for (let offset = 0; offset < Math.min(columnRepeat, MAX_ODS_COLUMNS - column); offset += 1) {
          cells.push({ reference: `${columnName(column + offset)}${rowNumber}`, column: column + offset, row: rowNumber, value })
        }
      }
      column += columnRepeat
    }
    const first = cells[0]
    const last = cells.at(-1)
    if (first && last) {
      for (let offset = 0; offset < Math.min(rowRepeat, MAX_ODS_REPEAT); offset += 1) {
        rows.push({ cells, firstColumn: first.column, lastColumn: last.column, row: rowNumber + offset })
      }
      omittedRows += Math.max(0, rowRepeat - MAX_ODS_REPEAT)
    }
    rowNumber += rowRepeat
  }
  return { rows, omittedRows }
}

const odsSheetName = (table: string): string => attribute(table.match(/^<table:table\b[^>]*>/i)?.[0] ?? "", "table:name") ?? "Sheet"

const extractOds = (archive: Unzipped, images: EmbeddedImages): string | undefined => {
  const contentPath = "content.xml"
  const content = xml(archive, contentPath)
  if (!content) return
  const sections = ["# Workbook"]
  for (const table of tagBlocks(content, "table:table")) {
    sections.push(`## Sheet: ${odsSheetName(table)}`)
    for (const shapes of tagBlocks(table, "table:shapes")) {
      sections.push(...odfContent(shapes, contentPath, images))
    }
    for (const row of odsRows(table, (cell) => odfContent(cell, contentPath, images).join(" ")).rows) {
      const values = new Map(row.cells.map((cell) => [cell.column, cell.value]))
      sections.push(Array.from({ length: row.lastColumn + 1 }, (_, column) => values.get(column) ?? "").join(" | "))
    }
  }
  return `${sections.join("\n\n")}\n`
}

const createArchiveEntryValidator = () => {
  let entries = 0
  let uncompressedBytes = 0

  return (info: UnzipFileInfo): void => {
    entries += 1
    uncompressedBytes += info.originalSize
    if (entries > MAX_ARCHIVE_ENTRIES) throw new Error("Document contains too many files")
    if (info.originalSize > MAX_ENTRY_BYTES) throw new Error("Document contains an oversized file")
    if (/\.(?:xml|rels)$/i.test(info.name) && info.originalSize > MAX_XML_ENTRY_BYTES) {
      throw new Error("Document contains XML that is too large to process safely")
    }
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("Document expands beyond the 100 MB safety limit")
    const normalized = normalizeArchivePath(info.name)
    const canonicalName = info.name.endsWith("/") ? info.name.slice(0, -1) : info.name
    if (
      !normalized
      || normalized !== canonicalName
      || info.name.includes("\\")
      || /^[a-z]:/i.test(info.name)
      || hasControlCharacters(info.name)
    ) {
      throw new Error("Document contains an unsafe file path")
    }
  }
}

const shouldExtractArchiveEntry = (info: UnzipFileInfo): boolean => {
  const extension = extensionOf(info.name)
  return extension === "xml" || extension === "rels" || IMAGE_MIMES.has(extension)
}

const validateArchiveMetadata = async (data: Uint8Array): Promise<void> => {
  const validateArchiveEntry = createArchiveEntryValidator()
  if ("Bun" in globalThis) {
    unzipSync(data, { filter: (info) => {
      validateArchiveEntry(info)
      return false
    } })
    return
  }

  await new Promise<void>((resolve, reject) => {
    unzip(data, { filter: (info) => {
      validateArchiveEntry(info)
      return false
    } }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

const validateExtractedArchive = (archive: Unzipped): void => {
  let uncompressedBytes = 0
  for (const [path, bytes] of Object.entries(archive)) {
    uncompressedBytes += bytes.byteLength
    if (bytes.byteLength > MAX_ENTRY_BYTES) throw new Error("Document contains an oversized file")
    if (/\.(?:xml|rels)$/i.test(path) && bytes.byteLength > MAX_XML_ENTRY_BYTES) {
      throw new Error("Document contains XML that is too large to process safely")
    }
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("Document expands beyond the 100 MB safety limit")
  }
}

const unzipDocument = async (file: File): Promise<Unzipped> => {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error("Document exceeds the 20 MB attachment limit")
  const data = new Uint8Array(await file.arrayBuffer())
  await validateArchiveMetadata(data)

  // Bun's browser-style Blob workers do not reliably execute fflate's async decoder.
  // Production browser runtimes use the worker-backed path below.
  const archive = "Bun" in globalThis
    ? unzipSync(data, { filter: shouldExtractArchiveEntry })
    : await new Promise<Unzipped>((resolve, reject) => {
      unzip(data, { filter: shouldExtractArchiveEntry }, (error, result) => {
        if (error) reject(error)
        else resolve(result)
      })
    })
  validateExtractedArchive(archive)
  return archive
}

const extractDocumentText = (extension: string, archive: Unzipped, images: EmbeddedImages): string | undefined => {
  switch (extension) {
    case "docx":
      return extractDocx(archive, images)
    case "pptx":
      return extractPptx(archive, images)
    case "xlsx":
      return extractXlsx(archive, images)
    case "odt":
      return extractOdt(archive, images)
    case "odp":
      return extractOdp(archive, images)
    case "ods":
      return extractOds(archive, images)
    default:
      return undefined
  }
}

const boundExtractedText = (text: string, imageFilenames: Set<string>): string => {
  if (text.length <= MAX_EXTRACTED_TEXT_CHARS) return text

  let end = MAX_EXTRACTED_TEXT_CHARS - TEXT_TRUNCATION_NOTICE.length
  const lastOpenBracket = text.lastIndexOf("[", end - 1)
  const lastCloseBracket = text.lastIndexOf("]", end - 1)
  if (lastOpenBracket > lastCloseBracket) {
    const nextCloseBracket = text.indexOf("]", lastOpenBracket)
    const candidate = nextCloseBracket === -1 ? "" : text.slice(lastOpenBracket + 1, nextCloseBracket)
    if (imageFilenames.has(candidate)) end = lastOpenBracket
  }
  return `${text.slice(0, end)}${TEXT_TRUNCATION_NOTICE}`
}

const citedImageFilenames = (text: string): Set<string> => {
  const filenames = new Set<string>()
  for (const match of text.matchAll(/\[([^\]\r\n]+)\]/g)) filenames.add(match[1])
  return filenames
}

export const extractDocumentAttachments = async (
  file: File,
  reservedFilenames: Iterable<string> = [],
): Promise<ExtractedDocumentAttachments | undefined> => {
  const extension = extensionOf(file.name)
  if (!OFFICE_EXTENSIONS.has(extension)) return
  const archive = await unzipDocument(file)
  const images = new EmbeddedImages(archive, file.name, reservedFilenames)
  const text = extractDocumentText(extension, archive, images)
  if (!text) return
  const extractedImages = images.all()
  const imageFilenames = new Set(extractedImages.map((image) => image.name))
  const boundedText = boundExtractedText(text, imageFilenames)
  const citations = citedImageFilenames(boundedText)
  return {
    textFile: new File([boundedText], file.name, { type: "text/plain" }),
    images: extractedImages.filter((image) => citations.has(image.name)),
  }
}

export type WorkbookSheet = {
  name: string
  /** The sheet's row number for each entry of `rows`; rows without values are left out. */
  rowNumbers: number[]
  rows: string[][]
  columnCount: number
  /** Rows with values in the file, including the ones past `rowCap`. */
  totalRows: number
}

const workbookSheet = (name: string, rows: SpreadsheetRow[], rowCap: number, omittedRows = 0): WorkbookSheet => {
  const kept = rows.slice(0, rowCap)
  const columnCount = Math.min(MAX_WORKBOOK_COLUMNS, kept.reduce((max, row) => Math.max(max, row.lastColumn + 1), 0))
  return {
    name,
    rowNumbers: kept.map((row) => row.row),
    rows: kept.map((row) => {
      const values = Array.from({ length: columnCount }, () => "")
      for (const cell of row.cells) if (cell.column < columnCount) values[cell.column] = cell.value
      return values
    }),
    columnCount,
    totalRows: rows.length + omittedRows,
  }
}

const odsCellText = (cell: string): string => elements(cell, "text:p")
  .map((paragraph) => decodeXml(paragraph
    .replace(/<text:s\b[^>]*\/?\s*>/gi, expandOdfSpaces)
    .replace(/<text:line-break\b[^>]*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")))
  .join("\n")

/** An XLSX or ODS file as tables of shown values, for the Files viewer. */
export const readWorkbook = async (file: File, rowCap: number): Promise<WorkbookSheet[] | undefined> => {
  const extension = extensionOf(file.name)
  const archive = await unzipDocument(file)
  if (extension === "xlsx") {
    return xlsxSheets(archive)?.map((sheet) => workbookSheet(sheet.name, sheet.rows, rowCap))
  }
  if (extension !== "ods") return
  const content = xml(archive, "content.xml")
  if (!content) return
  return tagBlocks(content, "table:table").map((table) => {
    const { rows, omittedRows } = odsRows(table, odsCellText)
    return workbookSheet(odsSheetName(table), rows, rowCap, omittedRows)
  })
}
