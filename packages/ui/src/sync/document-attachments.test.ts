import { describe, expect, test } from "bun:test"
import { strToU8, zipSync } from "fflate"
import { extractDocumentAttachments } from "./document-attachments"

const zippedFile = (name: string, entries: Record<string, string | Uint8Array>) => new File([
  zipSync(Object.fromEntries(Object.entries(entries).map(([path, value]) => [
    path,
    typeof value === "string" ? strToU8(value) : value,
  ]))),
], name)

const relationships = (items: Array<{ id: string; target: string; type?: string }>) => `
  <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    ${items.map((item) => `<Relationship Id="${item.id}" Target="${item.target}" Type="${item.type ?? "image"}"/>`).join("")}
  </Relationships>
`

const pngBytes = (suffix = 0) => new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, suffix])
const jpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])
const webpBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
])

describe("document attachment extraction", () => {
  test("extracts DOCX text and preserves inline image citations", async () => {
    const file = zippedFile("report.docx", {
      "word/document.xml": `
        <w:document xmlns:w="w" xmlns:a="a" xmlns:r="r">
          <w:body>
            <w:p><w:r><w:t>Before image</w:t></w:r></w:p>
            <w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>
            <w:p><w:r><w:t>After image</w:t></w:r></w:p>
          </w:body>
        </w:document>`,
      "word/_rels/document.xml.rels": relationships([{ id: "rId1", target: "media/image1.png" }]),
      "word/media/image1.png": pngBytes(),
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.includes("Before image\n\n[report-image-1.png]\n\nAfter image")).toBe(true)
    expect(result?.textFile.name).toBe("report.docx")
    expect(result?.textFile.type.startsWith("text/plain")).toBe(true)
    expect(result?.images).toHaveLength(1)
    expect(result?.images[0]?.name).toBe("report-image-1.png")
    expect(result?.images[0]?.type).toBe("image/png")

    const deduplicated = await extractDocumentAttachments(file, ["report-image-1.png"])
    expect((await deduplicated?.textFile.text())?.includes("[report-image-2.png]")).toBe(true)
    expect(deduplicated?.images[0]?.name).toBe("report-image-2.png")
  })

  test("extracts PPTX slide text, notes, and pictures", async () => {
    const file = zippedFile("deck.pptx", {
      "ppt/slides/slide1.xml": `
        <p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r">
          <a:p><a:r><a:t>Slide title</a:t></a:r></a:p>
          <p:pic><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill></p:pic>
        </p:sld>`,
      "ppt/slides/_rels/slide1.xml.rels": relationships([
        { id: "rIdImage", target: "../media/image1.jpeg" },
        { id: "rIdNotes", target: "../notesSlides/notesSlide1.xml", type: "http://example/notesSlide" },
      ]),
      "ppt/notesSlides/notesSlide1.xml": `<p:notes xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:notes>`,
      "ppt/media/image1.jpeg": jpegBytes,
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.includes("## Slide 1")).toBe(true)
    expect(text.includes("Slide title")).toBe(true)
    expect(text.includes("[deck-image-1.jpg]")).toBe(true)
    expect(text.includes("### Slide 1 notes\n\nSpeaker note")).toBe(true)
    expect(result?.images[0]?.name).toBe("deck-image-1.jpg")
  })

  test("extracts XLSX cell values and anchors pictures to cells", async () => {
    const file = zippedFile("budget.xlsx", {
      "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Summary" r:id="rIdSheet"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": relationships([{ id: "rIdSheet", target: "worksheets/sheet1.xml" }]),
      "xl/sharedStrings.xml": `<sst><si><t>Revenue</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `
        <worksheet xmlns:r="r"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData><drawing r:id="rIdDrawing"/></worksheet>`,
      "xl/worksheets/_rels/sheet1.xml.rels": relationships([{ id: "rIdDrawing", target: "../drawings/drawing1.xml" }]),
      "xl/drawings/drawing1.xml": `
        <xdr:wsDr xmlns:xdr="xdr" xmlns:a="a" xmlns:r="r"><xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:row>2</xdr:row></xdr:from><a:blip r:embed="rIdImage"/></xdr:oneCellAnchor></xdr:wsDr>`,
      "xl/drawings/_rels/drawing1.xml.rels": relationships([{ id: "rIdImage", target: "../media/image1.webp" }]),
      "xl/media/image1.webp": webpBytes,
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.includes("## Sheet: Summary")).toBe(true)
    expect(text.includes("A1: Revenue | B1: 42")).toBe(true)
    expect(text.includes("Image at B3: [budget-image-1.webp]")).toBe(true)
    expect(result?.images[0]?.name).toBe("budget-image-1.webp")
  })

  test("extracts OpenDocument text, presentations, spreadsheets, and image positions", async () => {
    const image = pngBytes()
    const odt = zippedFile("notes.odt", {
      "content.xml": `<office:document xmlns:office="office" xmlns:text="text" xmlns:draw="draw" xmlns:xlink="xlink"><text:h>Heading</text:h><text:p>Hello <text:span>world</text:span></text:p><draw:frame><draw:image xlink:href="Pictures/photo.png"/></draw:frame><text:p>After image</text:p></office:document>`,
      "Pictures/photo.png": image,
    })
    const odp = zippedFile("slides.odp", {
      "content.xml": `<office:document xmlns:office="office" xmlns:text="text" xmlns:draw="draw"><draw:page draw:name="Intro"><text:p>Welcome</text:p></draw:page></office:document>`,
    })
    const ods = zippedFile("table.ods", {
      "content.xml": `<office:document xmlns:office="office" xmlns:text="text" xmlns:table="table" xmlns:draw="draw" xmlns:xlink="xlink"><table:table table:name="Data"><table:shapes><draw:frame><draw:image xlink:href="Pictures/chart.png"/></draw:frame></table:shapes><table:table-row><table:table-cell><text:p>Name</text:p></table:table-cell><table:table-cell><text:p>Value</text:p></table:table-cell></table:table-row></table:table></office:document>`,
      "Pictures/chart.png": image,
    })

    const odtResult = await extractDocumentAttachments(odt)
    const odpResult = await extractDocumentAttachments(odp)
    const odsResult = await extractDocumentAttachments(ods)

    expect((await odtResult?.textFile.text())?.includes("Heading\n\nHello world\n\n[notes-image-1.png]\n\nAfter image")).toBe(true)
    expect(odtResult?.images).toHaveLength(1)
    expect((await odpResult?.textFile.text())?.includes("## Slide: Intro\n\nWelcome")).toBe(true)
    expect((await odsResult?.textFile.text())?.includes("## Sheet: Data\n\n[table-image-1.png]\n\nName | Value")).toBe(true)
    expect(odsResult?.images).toHaveLength(1)
  })

  test("rejects unsafe archive paths", async () => {
    const file = zippedFile("unsafe.docx", {
      "../word/document.xml": `<w:document xmlns:w="w"><w:p><w:t>Unsafe</w:t></w:p></w:document>`,
    })
    await expect(extractDocumentAttachments(file)).rejects.toThrow("unsafe file path")
  })

  test("rejects archives over the entry-count limit", async () => {
    const entries = Object.fromEntries(Array.from({ length: 5_001 }, (_, index) => [
      `metadata/entry-${index}.xml`,
      "<metadata/>",
    ]))

    await expect(extractDocumentAttachments(zippedFile("too-many.docx", entries))).rejects.toThrow("too many files")
  })

  test("bounds embedded image count and marks omitted images in document text", async () => {
    const imageTags = Array.from({ length: 51 }, (_, index) => `<w:p><a:blip r:embed="rId${index}"/></w:p>`).join("")
    const relationshipItems = Array.from({ length: 51 }, (_, index) => ({
      id: `rId${index}`,
      target: `media/image${index}.png`,
    }))
    const entries: Record<string, string | Uint8Array> = {
      "word/document.xml": `<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>${imageTags}</w:body></w:document>`,
      "word/_rels/document.xml.rels": relationships(relationshipItems),
    }
    for (let index = 0; index < 51; index += 1) entries[`word/media/image${index}.png`] = pngBytes(index)

    const result = await extractDocumentAttachments(zippedFile("gallery.docx", entries))
    const text = await result?.textFile.text() ?? ""

    expect(result?.images).toHaveLength(50)
    expect(text.includes("[Embedded image omitted by attachment limits: image50.png]")).toBe(true)
  })

  test("omits unsupported and spoofed embedded image content", async () => {
    const file = zippedFile("unsafe-images.docx", {
      "word/document.xml": `
        <w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>
          <w:p><a:blip r:embed="svg"/></w:p>
          <w:p><a:blip r:embed="fakePng"/></w:p>
        </w:body></w:document>`,
      "word/_rels/document.xml.rels": relationships([
        { id: "svg", target: "media/image.svg" },
        { id: "fakePng", target: "media/fake.png" },
      ]),
      "word/media/image.svg": `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
      "word/media/fake.png": new Uint8Array([1, 2, 3]),
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(result?.images).toEqual([])
    expect(text.includes("[Unsupported embedded image omitted: image.svg]")).toBe(true)
    expect(text.includes("[Invalid embedded image omitted: fake.png]")).toBe(true)
  })

  test("bounds expanded ODF spaces", async () => {
    const file = zippedFile("spaces.odt", {
      "content.xml": `<office:document xmlns:office="office" xmlns:text="text"><text:p>Before<text:s text:c="999999999999999999999"/>After</text:p></office:document>`,
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.includes("[Additional spaces omitted]After")).toBe(true)
    expect(text.length).toBeLessThan(1_000)
  })

  test("does not retain images whose citations fall beyond the text limit", async () => {
    const file = zippedFile("long.docx", {
      "word/document.xml": `<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body><w:p><w:t>${"x".repeat(2_000_100)}</w:t></w:p><w:p><a:blip r:embed="image"/></w:p></w:body></w:document>`,
      "word/_rels/document.xml.rels": relationships([{ id: "image", target: "media/image.png" }]),
      "word/media/image.png": pngBytes(),
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.length <= 2_000_000).toBe(true)
    expect(text.endsWith("[Document text truncated by OpenChamber]\n")).toBe(true)
    expect(text.includes("[long-image-1.png]")).toBe(false)
    expect(result?.images).toEqual([])
  })
})
