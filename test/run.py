"""Drives the online app against the mock server: auth, roles, CRUD, printing."""
from playwright.sync_api import sync_playwright
from PIL import Image
import zxingcpp, subprocess, glob, os, re, sys
URL = "file:///home/claude/repo/test/index.html"
errs, fails = [], []
def check(label, got, want):
    ok = got == want
    if not ok: fails.append(f"{label}: got {got!r} want {want!r}")
    print(("PASS " if ok else "FAIL "), label, "->", got)

with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={"width":1400,"height":1000}, device_scale_factor=2)
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append("console: "+m.text)
        if m.type=="error" and "ERR_TUNNEL" not in m.text and "fonts.googleapis" not in m.text else None)
    pg.goto(URL); pg.wait_for_timeout(400)
    pg.evaluate("localStorage.clear()"); pg.reload(); pg.wait_for_timeout(600)

    check("app hidden before sign-in", pg.is_visible(".wrap"), False)
    check("sign-in shown", pg.is_visible("#login-panel"), True)
    # the handbook ships with the app, and is reachable before you have a role
    check("the handbook is linked from the sign-in card",
          pg.is_visible('.gateFoot a[href$="handbook.html"]'), True)

    # domain guard on sign-up
    pg.click('[data-gate="signup"]'); pg.wait_for_timeout(200)
    pg.fill("#su-name","Nomer Santos"); pg.fill("#su-email","nomer@gmail.com")
    pg.fill("#su-pass","labelpress1"); pg.fill("#su-pass2","labelpress1")
    pg.click("#signup-panel button[type=submit]"); pg.wait_for_timeout(400)
    check("outside-domain sign-up refused", "limited to @meatplus.ph" in pg.inner_text("#su-msg"), True)

    # first account becomes admin
    pg.fill("#su-email","nomer@meatplus.ph"); pg.click("#signup-panel button[type=submit]"); pg.wait_for_timeout(800)
    check("first account signed in", pg.is_visible(".wrap"), True)
    check("first account is admin", pg.inner_text("#who-role").lower(), "admin")
    check("and from the top bar, in a new tab",
          pg.get_attribute('.who a[href$="handbook.html"]', "target"), "_blank")

    # customers + products via the UI
    pg.click('[data-tab="customers"]'); pg.wait_for_timeout(200)
    pg.fill("#c-name","Hard Discount Philippines,Inc."); pg.fill("#c-code","DALI")
    pg.click("#b-cadd"); pg.wait_for_timeout(400)
    pg.fill("#c-name","AllJoy Foods"); pg.fill("#c-code","ALLJOY"); pg.fill("#c-w","60"); pg.fill("#c-h","40")
    pg.click("#b-cadd"); pg.wait_for_timeout(500)
    check("customers in db", pg.evaluate("__DB.lbl_customers.map(c=>c.name+'/'+c.code)"),
          ["Hard Discount Philippines,Inc./DALI","AllJoy Foods/ALLJOY"])
    check("customer stock saved", pg.evaluate("!!__DB.lbl_customers.find(c=>c.code=='ALLJOY').stock"), True)

    # a customer can carry a logo, shrunk on the way in
    i = pg.evaluate("customers.findIndex(c=>c.code=='DALI')")
    pg.click(f'[data-cedit="{i}"]'); pg.wait_for_timeout(300)
    pg.set_input_files("#c-logo-file", "/tmp/testlogo.png"); pg.wait_for_timeout(600)
    check("logo preview appears", pg.evaluate("!!document.querySelector('#c-logo-box img')"), True)
    pg.click("#b-cadd"); pg.wait_for_timeout(600)
    logo = pg.evaluate("__DB.lbl_customers.find(c=>c.code=='DALI').logo || ''")
    check("logo saved to the customer", logo.startswith("data:image/"), True)
    check("logo is small enough for a row", len(logo) < 60000, True)
    check("logo shows beside the name in the list",
          pg.evaluate("!!document.querySelector('#cus-body .coMark')"), True)
    pg.click('[data-tab="print"]'); pg.wait_for_timeout(200)
    pg.select_option("#f-cust", pg.evaluate("customers.find(c=>c.code=='DALI').id")); pg.wait_for_timeout(400)
    check("logo shows beside the customer picker",
          pg.evaluate("!!document.querySelector('#f-cust-mark img')"), True)
    pg.select_option("#f-cust", ""); pg.wait_for_timeout(300)
    check("and clears when no customer is chosen",
          pg.evaluate("!document.querySelector('#f-cust-mark img')"), True)
    pg.click('[data-tab="customers"]'); pg.wait_for_timeout(200)

    pg.click('[data-tab="products"]'); pg.wait_for_timeout(200)
    dali = pg.evaluate("customers.find(c=>c.code=='DALI').id")
    pg.fill("#n-name","AllJoy Chicken Liver"); pg.fill("#n-size","250g"); pg.fill("#n-code","39012472")
    pg.select_option("#n-cust", dali); pg.click("#b-add"); pg.wait_for_timeout(500)
    check("product in db", pg.evaluate("__DB.lbl_products.map(p=>p.name+'/'+p.code)"), ["AllJoy Chicken Liver/39012472"])

    # edit it
    pg.click('[data-pedit="0"]'); pg.wait_for_timeout(300)
    pg.fill("#n-size","500g"); pg.click("#b-add"); pg.wait_for_timeout(500)
    check("edit persisted", pg.evaluate("__DB.lbl_products[0].size"), "500g")

    # print → log row in the database, with the operator name
    pg.click('[data-tab="print"]'); pg.evaluate("window.print=()=>{}")
    # the picker names the barcode number, so two products with the same name
    # and pack size can be told apart before choosing rather than after
    check("the product list shows the barcode number",
          pg.eval_on_selector_all("#f-pick option", "o=>o.map(x=>x.textContent)"),
          ["Custom entry", "AllJoy Chicken Liver · 500g · 39012472"])
    pg.fill("#f-code", ""); pg.wait_for_timeout(200)
    pg.select_option("#f-pick", label="AllJoy Chicken Liver · 500g · 39012472"); pg.wait_for_timeout(300)
    check("choosing one fills the barcode number", pg.input_value("#f-code"), "39012472")
    check("and the name and pack size with it",
          [pg.input_value("#f-name"), pg.input_value("#f-size")], ["AllJoy Chicken Liver", "500g"])
    pg.fill("#f-copies","2"); pg.click("#b-print"); pg.wait_for_timeout(600)
    check("log written", pg.evaluate("__DB.lbl_print_log.length"), 1)
    check("log carries the operator", pg.evaluate("__DB.lbl_print_log[0].by_name"), "Nomer Santos")
    check("log carries the customer", pg.evaluate("__DB.lbl_print_log[0].customer_name").startswith("Hard Discount"), True)

    # the printed label still scans
    print("   sheet labels:", pg.evaluate("document.querySelectorAll('#sheet .label').length"),
          "| page css:", pg.evaluate("(document.getElementById('pageStyle')||{}).textContent"))
    pg.pdf(path="/home/claude/repo/test/out.pdf", prefer_css_page_size=True, print_background=True)
    subprocess.run("pdfinfo /home/claude/repo/test/out.pdf | egrep 'Pages|Page size'", shell=True)
    for f in glob.glob("/home/claude/repo/test/pg-*.png"): os.remove(f)
    subprocess.run("pdftoppm -r 600 -png /home/claude/repo/test/out.pdf /home/claude/repo/test/pg", shell=True)
    codes = []
    for f in sorted(glob.glob("/home/claude/repo/test/pg-*.png")):
        r = zxingcpp.read_barcodes(Image.open(f).convert("RGB"))
        codes.append(r[0].text if r else None)
    check("both copies print and scan", codes, ["39012472\n","39012472\n"])

    # The code type belongs to the stock, so it is set on Label setup and
    # nowhere else; this helper stands in for the two clicks a person makes.
    def set_sym(value):
        pg.click('[data-tab="setup"]'); pg.wait_for_timeout(250)
        pg.select_option("#s-sym", value); pg.wait_for_timeout(650)
        pg.click('[data-tab="print"]'); pg.wait_for_timeout(250)

    # ---- the same number as a QR code ----
    # Switching the code type is a stock setting like any other measurement, so
    # it is remembered against the customer and the label re-fits around a
    # square instead of a strip. What the scanner reads must not change.
    set_sym("qr")
    check("preview swaps to a QR", pg.evaluate(
        "!!document.querySelector('#stageInner svg[aria-label=\"QR code\"]')"), True)
    check("and the bars are gone", pg.evaluate(
        "!document.querySelector('#stageInner svg[aria-label=\"Barcode\"]')"), True)
    check("the readout names the version", "version" in pg.inner_text("#specs").lower(), True)
    check("no complaints about the fit", pg.evaluate(
        "!document.querySelector('#flags .flag.bad')"), True)
    zpl = pg.inner_text("#zpl")
    check("zpl emits a QR field", "^BQN,2," in zpl, True)
    check("zpl drops the Code 128 field", "^BCN," not in zpl, True)
    check("zpl carries the number and the Enter suffix", "A,39012472_0a^FS" in zpl, True)

    pg.evaluate("window.print=()=>{}")
    pg.fill("#f-copies","1"); pg.click("#b-print"); pg.wait_for_timeout(600)
    pg.pdf(path="/home/claude/repo/test/qr.pdf", prefer_css_page_size=True, print_background=True)
    for f in glob.glob("/home/claude/repo/test/qp-*.png"): os.remove(f)
    subprocess.run("pdftoppm -r 600 -png /home/claude/repo/test/qr.pdf /home/claude/repo/test/qp", shell=True)
    qcodes = []
    for f in sorted(glob.glob("/home/claude/repo/test/qp-*.png")):
        r = zxingcpp.read_barcodes(Image.open(f).convert("RGB"))
        qcodes += [(str(b.format), b.text) for b in r]
    check("the printed QR scans to the same number", qcodes, [("QR Code", "39012472\n")])

    # the queue remembers the code type it was queued with
    pg.click("#b-addq"); pg.wait_for_timeout(400)
    check("the queued line records the code type", pg.evaluate("queue[0].sym"), "qr")
    set_sym("c128")
    pg.click("#b-printq"); pg.wait_for_timeout(700)
    check("the queued label still prints as a QR", pg.evaluate(
        "!!document.querySelector('#sheet svg[aria-label=\"QR code\"]')"), True)
    pg.click("#b-clearq"); pg.wait_for_timeout(300)

    check("switching back restores the bars", pg.evaluate(
        "!!document.querySelector('#stageInner svg[aria-label=\"Barcode\"]')"), True)
    check("the choice is remembered on the customer",
          pg.evaluate("(customers.find(c=>c.code=='DALI').stock||{}).sym"), "c128")

    # The picker is on Label setup and only there — the Print tab is for what
    # goes on this run, not for how the customer's labels are set up.
    pg.click('[data-tab="setup"]'); pg.wait_for_timeout(300)
    check("Label setup offers every code type",
          pg.eval_on_selector_all("#s-sym option", "o=>o.map(x=>x.value)"),
          ["c128","gs1128","ean13","ean8","upca","itf14","qr","qrdl"])
    pg.click('[data-tab="print"]'); pg.wait_for_timeout(300)
    check("the Print tab does not offer it as well",
          pg.evaluate("!document.querySelector('#f-sym')"), True)

    # ---- every other code type, printed and scanned back ----
    # A retail code is only worth printing if a scanner agrees with it, so each
    # one goes through the whole path: preview, page, PDF, 600 dpi raster, decode.
    def print_and_scan(tag):
        pg.evaluate("window.print=()=>{}")
        pg.fill("#f-copies", "1"); pg.click("#b-print"); pg.wait_for_timeout(600)
        path = "/home/claude/repo/test/sym-%s.pdf" % tag
        pg.pdf(path=path, prefer_css_page_size=True, print_background=True)
        for f in glob.glob("/home/claude/repo/test/sp-*.png"): os.remove(f)
        subprocess.run("pdftoppm -r 600 -png %s /home/claude/repo/test/sp" % path, shell=True)
        found = []
        for f in sorted(glob.glob("/home/claude/repo/test/sp-*.png")):
            found += [(str(b.format), b.text) for b in zxingcpp.read_barcodes(Image.open(f).convert("RGB"))]
        os.remove(path)
        return found

    for sym, code, want in [
        ("ean13", "480123456789",  [("EAN-13", "4801234567897")]),
        ("ean8",  "4801234",       [("EAN-8",  "48012348")]),
        ("upca",  "03600029145",   [("EAN-13", "0036000291452")]),   # a UPC-A is an EAN-13 with a leading zero
        ("itf14", "1480123456789", [("ITF",    "14801234567894")]),
    ]:
        pg.fill("#f-code", code)
        set_sym(sym)
        check(sym + " draws its own digits", pg.evaluate(
            "!!document.querySelector('#stageInner svg[aria-label$=\" barcode\"] text')"), True)
        check(sym + " has no complaint", pg.evaluate("!document.querySelector('#flags .flag.bad')"), True)
        check(sym + " prints and scans", print_and_scan(sym), want)

    # a wrong check digit must stop the label, not print a number belonging to someone else
    set_sym("ean13"); pg.fill("#f-code", "4801234567890"); pg.wait_for_timeout(700)
    check("a bad check digit is refused", "check digit" in pg.inner_text("#flags"), True)
    check("and nothing is drawn", pg.evaluate(
        "!document.querySelector('#stageInner svg[aria-label=\"EAN13 barcode\"]')"), True)

    # GS1-128 carries the dates and the batch, and comes back out as fields
    pg.fill("#f-code", "39012472")
    set_sym("gs1128")
    check("the batch box appears for a code that can carry it", pg.is_visible("#f-batch"), True)
    pg.fill("#f-batch", "L2608A"); pg.wait_for_timeout(700)
    check("the readout lists what it carries",
          "Production date" in pg.inner_text("#carries"), True)
    got = print_and_scan("gs1128")
    check("GS1-128 prints and scans as fields", got,
          [("Code 128", "(11)260826(17)270826(240)39012472(10)L2608A")])

    # a Digital Link needs a real GTIN and says so rather than inventing one
    set_sym("qrdl")
    check("a Digital Link without a GTIN is refused", "GTIN" in pg.inner_text("#flags"), True)
    pg.fill("#f-code", "4801234567897"); pg.wait_for_timeout(800)
    check("with a GTIN it points somewhere",
          "id.gs1.org/01/04801234567897" in pg.inner_text("#carries"), True)
    # A Digital Link is a long payload, so the code grows; the label was fitted
    # while it was still being refused, and the app has to say so rather than
    # quietly printing a code with its edge cut off.
    check("it says the content no longer fits",
          "cut off" in pg.inner_text("#flags"), True)
    pg.evaluate("autoFit()"); pg.wait_for_timeout(800)
    check("after re-fitting there is no complaint",
          pg.evaluate("!document.querySelector('#flags .flag.bad')"), True)
    check("the Digital Link QR scans", print_and_scan("qrdl"),
          [("QR Code", "https://id.gs1.org/01/04801234567897/10/L2608A?11=260826&17=270826")])

    pg.fill("#f-batch", ""); pg.fill("#f-code", "39012472")
    set_sym("c128")

    # the queue count is editable in place
    pg.click('[data-tab="print"]'); pg.wait_for_timeout(200)
    pg.fill("#f-copies","3"); pg.click("#b-addq"); pg.wait_for_timeout(400)
    check("queued with the form count", pg.input_value('[data-qty="0"]'), "3")
    check("queue total", pg.inner_text("#q-count").lower(), "3 labels")
    pg.fill('[data-qty="0"]', "12"); pg.wait_for_timeout(300)
    check("count edited in place", pg.evaluate("queue[0].copies"), 12)
    check("total follows", pg.inner_text("#q-count").lower(), "12 labels")
    check("the row keeps focus while typing",
          pg.evaluate("document.activeElement && document.activeElement.dataset.qty"), "0")
    pg.fill('[data-qty="0"]', "0"); pg.wait_for_timeout(200)
    check("zero is floored to one", pg.evaluate("queue[0].copies"), 1)
    pg.fill('[data-qty="0"]', "2"); pg.wait_for_timeout(200)
    pg.evaluate("document.querySelector('[data-qty=\"0\"]').blur()"); pg.wait_for_timeout(200)
    pg.evaluate("window.print=()=>{}")
    before = pg.evaluate("__DB.lbl_print_log.length")
    pg.click("#b-printq"); pg.wait_for_timeout(700)
    check("queue prints the edited count",
          pg.evaluate("document.querySelectorAll('#sheet .label').length"), 2)
    check("log records the edited count",
          pg.evaluate("__DB.lbl_print_log[0].copies"), 2)
    pg.click("#b-clearq"); pg.wait_for_timeout(300)
    check("queue cleared", pg.inner_text("#q-count").lower(), "0 labels")

    # the ZPL downloads as a file the printer can take as-is
    pg.click('[data-tab="print"]'); pg.wait_for_timeout(300)
    with pg.expect_download() as dl:
        pg.click("#b-dlzpl")
    d = dl.value
    check("zpl filename follows the barcode", d.suggested_filename, "39012472.zpl")
    path = "/tmp/dl.zpl"; d.save_as(path)
    body = open(path, "rb").read()
    check("zpl file starts correctly", body.startswith(b"^XA"), True)
    check("zpl file ends correctly", body.rstrip().endswith(b"^XZ"), True)
    check("zpl uses CRLF", b"\r\n" in body and b"\n\n" not in body, True)
    check("zpl ends with a newline", body.endswith(b"\r\n"), True)
    check("zpl carries the barcode and the Enter suffix", b"^FD39012472_0a^FS" in body, True)

    # settings are shared
    pg.click('[data-tab="setup"]'); pg.wait_for_timeout(200)
    pg.fill("#s-dark","18"); pg.wait_for_timeout(500)
    check("house settings saved", pg.evaluate("__DB.lbl_settings[0].data.dark"), 18)

    # ---- setting up a second company's stock ----
    # Label setup works on one company at a time and has its own picker for
    # choosing which; it is the same selection as the customer on the Print tab.
    dali   = pg.evaluate("customers.find(c=>c.code=='DALI').id")
    alljoy = pg.evaluate("customers.find(c=>c.code=='ALLJOY').id")
    check("the picker lists every customer plus the house default",
          pg.eval_on_selector_all("#s-scope option", "o=>o.length"), 3)
    pg.select_option("#s-scope", alljoy); pg.wait_for_timeout(600)
    check("the banner names the company", "AllJoy" in pg.inner_text("#scope"), True)
    check("the print tab follows the same choice", pg.input_value("#f-cust"), alljoy)
    house_w = pg.evaluate("house.w")
    pg.fill("#s-w","100"); pg.fill("#s-h","50"); pg.wait_for_timeout(800)
    check("the second company gets its own stock",
          pg.evaluate("(customers.find(c=>c.code=='ALLJOY').stock||{}).w"), 100)
    check("saved to the database too",
          pg.evaluate("(__DB.lbl_customers.find(c=>c.code=='ALLJOY').stock||{}).h"), 50)
    check("the first company is left alone",
          pg.evaluate("(customers.find(c=>c.code=='DALI').stock||{}).w"), 50)
    check("and so is the house default", pg.evaluate("house.w"), house_w)
    pg.select_option("#s-scope", dali); pg.wait_for_timeout(600)
    check("switching back reads that company's own size", pg.input_value("#s-w"), "50")

    # ---- stock that runs two labels across the roll ----
    # 43 x 33 mm die-cut, two side by side. The printer's page is the whole web,
    # but each label's content has to stay inside its own die cut: the failure
    # this guards against is content centred across the pair, straddling the
    # perforation.
    pg.select_option("#s-scope", alljoy); pg.wait_for_timeout(600)
    pg.select_option("#s-preset", "43x33"); pg.wait_for_timeout(700)
    check("the preset sets both measurements", pg.evaluate("[cfg.w,cfg.h]"), [43, 33])
    check("no gap is asked for while nothing sits beside it", pg.is_visible("#fld-colgap"), False)
    pg.select_option("#s-cols", "2"); pg.wait_for_timeout(700)
    check("the gap appears once labels sit side by side", pg.is_visible("#fld-colgap"), True)
    pg.fill("#s-colgap", "2"); pg.wait_for_timeout(800)
    check("the roll is the labels plus the gap between them", pg.evaluate("webWidth(cfg)"), 88)
    check("the label itself is still one label wide", pg.evaluate("cfg.w"), 43)
    check("the spec line names the roll", "88" in pg.inner_text("#specs"), True)
    check("the layout is saved against that company",
          pg.evaluate("(__DB.lbl_customers.find(c=>c.code=='ALLJOY').stock||{}).cols"), 2)
    # the preview shows what comes off the roll, which is now a pair
    check("the preview shows both labels",
          pg.eval_on_selector_all("#stageInner2 .webRow > .label", "e=>e.length"), 2)
    check("with the die cut marked between them",
          pg.eval_on_selector_all("#stageInner2 .webRow > .perf", "e=>e.length"), 1)
    check("and the preview is as wide as the roll",
          pg.evaluate("Math.round(document.querySelector('#stageInner2').getBoundingClientRect().width /"
                      " (document.querySelector('#stageInner2 .webRow > .label').getBoundingClientRect().width))"), 2)

    pg.click('[data-tab="print"]'); pg.wait_for_timeout(400)
    check("the Print tab previews the pair too",
          pg.eval_on_selector_all("#stageInner .webRow > .label", "e=>e.length"), 2)
    pg.fill("#f-name", "AllJoy Chicken Cut Ups"); pg.fill("#f-code", "39012472"); pg.wait_for_timeout(700)
    pg.evaluate("window.print=()=>{}")
    pg.fill("#f-copies", "3"); pg.click("#b-print"); pg.wait_for_timeout(800)
    check("three labels go out as two rows of two",
          pg.eval_on_selector_all("#sheet .pageRow", "r=>r.map(x=>x.childElementCount)"), [2, 1])
    check("the page is the width of the roll, not of one label",
          "size:88mm 33mm" in pg.evaluate("document.getElementById('pageStyle').textContent"), True)
    pg.pdf(path="/home/claude/repo/test/two-up.pdf", prefer_css_page_size=True, print_background=True)
    subprocess.run("pdfinfo /home/claude/repo/test/two-up.pdf | egrep 'Pages|Page size'", shell=True)
    for f in glob.glob("/home/claude/repo/test/tw-*.png"): os.remove(f)
    subprocess.run("pdftoppm -r 600 -png /home/claude/repo/test/two-up.pdf /home/claude/repo/test/tw", shell=True)
    sheets = sorted(glob.glob("/home/claude/repo/test/tw-*.png"))
    check("it prints as two sheets of stock", len(sheets), 2)
    scanned = []
    for f in sheets:
        scanned += [b.text for b in zxingcpp.read_barcodes(Image.open(f).convert("RGB"))]
    check("every label across the pair still scans", scanned, ["39012472\n"] * 3)
    # each barcode has to sit in its own half of the web, not across the middle
    im = Image.open(sheets[0]).convert("L")
    mid = im.width // 2
    dark = lambda box: sum(1 for px in im.crop(box).getdata() if px < 128)
    check("nothing is printed over the perforation",
          dark((mid - 12, 0, mid + 12, im.height)), 0)
    check("both halves of the web are used",
          dark((0, 0, mid, im.height)) > 0 and dark((mid, 0, im.width, im.height)) > 0, True)

    zpl = pg.evaluate("buildZPL(currentLabel(), 3)")
    check("the ZPL page is the whole roll",
          ("^PW" + str(pg.evaluate("mm2dots(webWidth(cfg))"))) in zpl, True)
    check("it draws a barcode in each column", zpl.count("^BCN"), 2)
    lw = pg.evaluate("mm2dots(cfg.w)")
    check("the second column is offset by a whole label",
          any(int(x) >= lw for x in re.findall(r"\^FO(\d+),", zpl)), True)
    # the printer feeds a row at a time, so three labels is two feeds
    check("the quantity counts feeds, not labels", "^PQ2,0,0,N" in zpl, True)

    # put it back to one across so the rest of the run is unaffected
    pg.click('[data-tab="setup"]'); pg.wait_for_timeout(300)
    pg.select_option("#s-cols", "1"); pg.wait_for_timeout(700)
    check("back on one across the preview is a single label",
          pg.evaluate("!document.querySelector('#stageInner2 .webRow')"
                      " && !!document.querySelector('#stageInner2 > .label')"), True)
    pg.select_option("#s-scope", dali); pg.wait_for_timeout(600)
    pg.click('[data-tab="print"]'); pg.wait_for_timeout(300)

    # second account lands pending
    pg.click("#b-signout"); pg.wait_for_timeout(600)
    pg.click('[data-gate="signup"]'); pg.wait_for_timeout(200)
    pg.fill("#su-name","Rosa dela Cruz"); pg.fill("#su-email","rosa@meatplus.ph")
    pg.fill("#su-pass","labelpress2"); pg.fill("#su-pass2","labelpress2")
    pg.click("#signup-panel button[type=submit]"); pg.wait_for_timeout(800)
    check("new account is held for approval", pg.is_visible("#pending-panel"), True)
    check("pending sees no app", pg.is_visible(".wrap"), False)

    # admin promotes her
    pg.click("#b-pending-out"); pg.wait_for_timeout(600)
    pg.fill("#li-email","nomer@meatplus.ph"); pg.fill("#li-pass","labelpress1")
    pg.click("#login-panel button[type=submit]"); pg.wait_for_timeout(800)
    pg.click('[data-tab="users"]'); pg.wait_for_timeout(400)
    check("users table columns",
          pg.eval_on_selector_all("#p-users thead th","e=>e.map(x=>x.textContent.trim()).filter(Boolean)"),
          ["Name","Username","Role","Last signed in"])
    check("username column shows the email",
          pg.evaluate("[...document.querySelectorAll('#usr-body tr')].some(r=>r.innerText.includes('rosa@meatplus.ph'))"),
          True)
    check("last signed in is recorded",
          pg.evaluate("!!__DB.lbl_profiles.find(p=>p.name==='Nomer Santos').last_seen"), True)

    # promote her through the Edit form, the way the offline build works
    i = pg.evaluate("profiles.findIndex(p=>p.name==='Rosa dela Cruz')")
    pg.click(f'[data-uedit="{i}"]'); pg.wait_for_timeout(300)
    check("edit fills the form", pg.input_value("#u-user"), "rosa@meatplus.ph")
    check("username is not editable", pg.is_disabled("#u-user"), True)
    pg.select_option("#u-role","operator")
    pg.click("#b-uadd"); pg.wait_for_timeout(700)
    check("role updated", pg.evaluate("__DB.lbl_profiles.find(p=>p.name==='Rosa dela Cruz').role"), "operator")
    check("form resets after saving", pg.inner_text("#usr-title").lower(), "add a user")

    # admin creates an account outright, password and all
    pg.fill("#u-name","Junjie Tupas"); pg.fill("#u-user","junjie.tupas@meatplus.ph")
    pg.select_option("#u-role","operator")
    pg.fill("#u-pin","labelpress3"); pg.fill("#u-pin2","labelpress3")
    pg.click("#b-uadd"); pg.wait_for_timeout(800)
    check("account created by the admin",
          pg.evaluate("__DB.lbl_profiles.find(p=>p.name==='Junjie Tupas').role"), "operator")
    check("and it has a real login",
          pg.evaluate("!!__DB.users.find(u=>u.email==='junjie.tupas@meatplus.ph')"), True)

    # mismatched passwords are refused
    pg.fill("#u-name","Broken One"); pg.fill("#u-user","broken@meatplus.ph")
    pg.fill("#u-pin","aaaaaa"); pg.fill("#u-pin2","bbbbbb")
    pg.click("#b-uadd"); pg.wait_for_timeout(400)
    check("mismatched passwords refused", pg.inner_text("#usr-msg"), "Those two do not match.")
    check("nothing was created", pg.evaluate("!__DB.users.find(u=>u.email==='broken@meatplus.ph')"), True)
    check("cancel stays hidden while adding", pg.is_visible("#b-ucancel"), False)
    pg.fill("#u-name",""); pg.fill("#u-user",""); pg.fill("#u-pin",""); pg.fill("#u-pin2","")

    # the last administrator cannot be demoted away
    j = pg.evaluate("profiles.findIndex(p=>p.name==='Nomer Santos')")
    check("cannot delete yourself", pg.evaluate(f"!document.querySelector('[data-udel=\"{j}\"]')"), True)

    # Lock puts the gate back without ending the session
    pg.click("#b-lock"); pg.wait_for_timeout(400)
    check("lock shows the sign-in gate", pg.is_visible("#login-panel"), True)
    check("lock keeps the session", pg.evaluate("!!sb.user()"), True)
    check("lock fills in the email", pg.input_value("#li-email"), "nomer@meatplus.ph")
    pg.fill("#li-pass","labelpress1")
    pg.click("#login-panel button[type=submit]"); pg.wait_for_timeout(900)
    check("unlocks again", pg.is_visible("#gate"), False)

    # operator: can print, cannot administer
    pg.click("#b-signout"); pg.wait_for_timeout(600)
    pg.fill("#li-email","rosa@meatplus.ph"); pg.fill("#li-pass","labelpress2")
    pg.click("#login-panel button[type=submit]"); pg.wait_for_timeout(900)
    check("every account has its own id",
          pg.evaluate("new Set(__DB.users.map(u=>u.id)).size === __DB.users.length"), True)
    check("operator signed in", pg.inner_text("#who-role").lower(), "operator")
    check("operator tabs",
          pg.eval_on_selector_all(".tabs button","e=>e.filter(x=>x.offsetParent!==null).map(x=>x.textContent.trim())"),
          ["Print","Products","Customers","Print log"])
    check("operator sees the shared products", pg.evaluate("catalog.length"), 1)
    pg.evaluate("window.print=()=>{}"); pg.click("#b-print"); pg.wait_for_timeout(600)
    check("operator print logged under her name", pg.evaluate("__DB.lbl_print_log[__DB.lbl_print_log.length-1].by_name"), "Rosa dela Cruz")
    check("operator cannot write products",
          pg.evaluate("(async()=>{try{await sb.insert('lbl_products',[{name:'x',code:'1',customer_id:null}]);return 'ALLOWED'}catch(e){return 'blocked'}})()"),
          "blocked")
    # the account-making function must refuse anyone who is not an administrator
    check("operator cannot create accounts",
          pg.evaluate("(async()=>{try{await db.admin('create',{name:'Sneak',email:'sneak@meatplus.ph',password:'sneak123',role:'admin'});return 'ALLOWED'}catch(e){return 'blocked'}})()"),
          "blocked")
    check("operator cannot revoke anyone",
          pg.evaluate("(async()=>{try{await db.admin('revoke',{id:profiles[0]&&profiles[0].id});return 'ALLOWED'}catch(e){return 'blocked'}})()"),
          "blocked")
    check("no sneak account exists", pg.evaluate("!__DB.users.find(u=>u.email==='sneak@meatplus.ph')"), True)

    # The code type is a stock setting on an administrator's tab, so an operator
    # prints whatever the customer is set up for and has no way to change it —
    # not by picker, because there is none, and not through the database either.
    stock_before = pg.evaluate("JSON.stringify(customers.find(c=>c.code=='DALI').stock||{})")
    check("an operator has no code-type picker",
          pg.evaluate("!document.querySelector('#s-sym') || !document.querySelector('.tabs [data-tab=\"setup\"]').offsetParent"), True)
    check("they print what the customer is set up for", pg.evaluate("cfg.sym"), "c128")
    check("and cannot write the stock even by hand", pg.evaluate(
        "(async()=>{try{await sb.update('lbl_customers','id=eq.'+customers.find(c=>c.code=='DALI').id,{stock:{sym:'qr'}});return 'ALLOWED'}catch(e){return 'blocked'}})()"),
        "blocked")
    check("so the stock is untouched",
          pg.evaluate("JSON.stringify((__DB.lbl_customers.find(c=>c.code=='DALI')||{}).stock||{})"), stock_before)

    # ---- the activity trail ----
    # An operator must not be able to read it, add to it under someone else's
    # name, or change what is already there.
    check("an operator has no Activity tab",
          pg.eval_on_selector_all(".tabs button", "e=>e.filter(x=>x.offsetParent!==null).map(x=>x.textContent.trim())"),
          ["Print","Products","Customers","Print log"])
    check("an operator reads nothing from it",
          pg.evaluate("(async()=>{try{return (await db.loadTrail()).length}catch(e){return 'refused'}})()"), 0)
    check("and cannot write to it directly", pg.evaluate(
        "(async()=>{try{await sb.insert('lbl_activity',[{actor_id:me.id,actor_name:'Nomer Santos',action:'forged'}]);return 'ALLOWED'}catch(e){return 'blocked'}})()"),
        "blocked")
    # A write the database filters away comes back as success with no rows, not
    # as an error — so what matters is that the rows did not move, not that it threw.
    check("nor change what is there", pg.evaluate(
        "(async()=>{const was=JSON.stringify(__DB.lbl_activity.map(r=>r.action));"
        "try{await sb.update('lbl_activity','id=gt.0',{action:'tampered'})}catch(e){}"
        "return JSON.stringify(__DB.lbl_activity.map(r=>r.action))===was ? 'unchanged' : 'TAMPERED'})()"),
        "unchanged")
    check("nor delete it", pg.evaluate(
        "(async()=>{const n=__DB.lbl_activity.length;"
        "try{await sb.remove('lbl_activity','id=gt.0')}catch(e){}"
        "return __DB.lbl_activity.length===n ? 'all still there' : 'ROWS LOST'})()"),
        "all still there")

    # ---- operator proposes; admin approves ----
    pg.click('[data-tab="products"]'); pg.wait_for_timeout(400)
    check("operator can reach Products", pg.is_visible("#b-add"), True)
    check("operator cannot import", pg.is_visible("#b-import"), False)
    # scoped to the panel: other tabs carry operator-only notes of their own
    check("operator sees the approval note", pg.is_visible('#p-products [data-op="1"]'), True)
    pg.fill("#n-name","AllJoy Chicken Feet"); pg.fill("#n-size","500g"); pg.fill("#n-code","39012480")
    pg.select_option("#n-cust", pg.evaluate("customers.find(c=>c.code=='DALI').id"))
    pg.click("#b-add"); pg.wait_for_timeout(800)
    row = pg.evaluate("__DB.lbl_products.find(p=>p.code==='39012480')")
    check("operator submission is pending", row["status"], "pending")
    check("submission is stamped with the operator", row["created_by"] == pg.evaluate("me.id"), True)
    check("pending row is tagged in the list",
          pg.evaluate("!!document.querySelector('#cat-body tr.isPending')"), True)
    check("operator gets no Approve button",
          pg.evaluate("!document.querySelector('[data-papprove]')"), True)

    # the pending product must not be printable
    pg.click('[data-tab="print"]'); pg.wait_for_timeout(400)
    check("pending product is not offered for printing",
          pg.evaluate("[...document.querySelectorAll('#f-pick option')].every(o=>!o.textContent.includes('Chicken Feet'))"), True)

    # and the operator cannot approve it themselves, however they ask
    check("operator cannot approve by API",
          pg.evaluate("(async()=>{try{await db.approveProduct(catalog.find(p=>p.code==='39012480'));return 'ALLOWED'}catch(e){return 'blocked'}})()"),
          "blocked")
    check("still pending after the attempt",
          pg.evaluate("__DB.lbl_products.find(p=>p.code==='39012480').status"), "pending")

    # operator proposes a customer too
    pg.click('[data-tab="customers"]'); pg.wait_for_timeout(300)
    pg.fill("#c-name","Puregold Price Club"); pg.fill("#c-code","PGOLD")
    pg.click("#b-cadd"); pg.wait_for_timeout(700)
    check("customer submission is pending",
          pg.evaluate("__DB.lbl_customers.find(c=>c.code==='PGOLD').status"), "pending")
    check("pending customer is not offered on the Print tab",
          pg.evaluate("[...document.querySelectorAll('#f-cust option')].every(o=>!o.textContent.includes('Puregold'))"), True)

    # admin signs in and approves
    pg.click("#b-signout"); pg.wait_for_timeout(600)
    pg.fill("#li-email","nomer@meatplus.ph"); pg.fill("#li-pass","labelpress1")
    pg.click("#login-panel button[type=submit]"); pg.wait_for_timeout(900)
    pg.click('[data-tab="products"]'); pg.wait_for_timeout(400)
    check("admin sees a pending badge", pg.is_visible("#pend-prod"), True)
    check("badge counts the queue", pg.inner_text("#pend-prod"), "1")
    i = pg.evaluate("catalog.findIndex(p=>p.code==='39012480')")
    pg.click(f'[data-papprove="{i}"]'); pg.wait_for_timeout(800)
    check("approved in the database",
          pg.evaluate("__DB.lbl_products.find(p=>p.code==='39012480').status"), "approved")
    check("badge clears", pg.evaluate("document.querySelector('#pend-prod').hidden"), True)
    pg.click('[data-tab="print"]'); pg.wait_for_timeout(500)
    check("approved product is now printable",
          pg.evaluate("[...document.querySelectorAll('#f-pick option')].some(o=>o.textContent.includes('Chicken Feet'))"), True)

    # admin rejects the proposed customer
    pg.click('[data-tab="customers"]'); pg.wait_for_timeout(400)
    j = pg.evaluate("customers.findIndex(c=>c.code==='PGOLD')")
    pg.on("dialog", lambda d: d.accept())
    pg.click(f'[data-cdel="{j}"]'); pg.wait_for_timeout(800)
    check("rejected customer is gone",
          pg.evaluate("!__DB.lbl_customers.find(c=>c.code==='PGOLD')"), True)

    pg.click("#b-signout"); pg.wait_for_timeout(600)
    pg.fill("#li-email","rosa@meatplus.ph"); pg.fill("#li-pass","labelpress2")
    pg.click("#login-panel button[type=submit]"); pg.wait_for_timeout(900)

    # session survives reload
    pg.reload(); pg.wait_for_timeout(1000)
    check("session survives reload", pg.inner_text("#who-name"), "Rosa dela Cruz")

    # ---- what an administrator sees in the trail ----
    pg.click("#b-signout"); pg.wait_for_timeout(600)
    pg.fill("#li-email","nomer@meatplus.ph"); pg.fill("#li-pass","labelpress1")
    pg.click("#login-panel button[type=submit]"); pg.wait_for_timeout(900)
    pg.click('[data-tab="trail"]'); pg.wait_for_timeout(700)
    rows = pg.evaluate("trailRows.map(r => r.who + ' | ' + r.action + ' | ' + r.name)")
    print("   trail:", "\n          ".join(rows[:12]))
    actions = {r.split(" | ")[1] for r in rows}
    for want in ("signed in", "added product", "added customer", "proposed product",
                 "approved product", "created account", "rejected customer"):
        check("the trail recorded: " + want, want in actions, True)
    check("an operator's proposal is filed under their own name",
          any(r.startswith("Rosa dela Cruz | proposed product") for r in rows), True)
    check("the approval is filed under the administrator's",
          any(r.startswith("Nomer Santos | approved product") for r in rows), True)
    check("printing is not duplicated here", "printed" in actions, False)

    # it is a view, not a store: filtering never loses a row
    before = pg.evaluate("trailRows.length")
    pg.select_option("#trail-kind", "product"); pg.wait_for_timeout(300)
    only_products = pg.evaluate("document.querySelectorAll('#trail-body tr').length")
    check("filtering by kind narrows the list", only_products < before, True)
    pg.select_option("#trail-kind", ""); pg.fill("#trail-q", "Rosa"); pg.wait_for_timeout(300)
    # the search covers every column, so an approval that says "proposed by Rosa"
    # matches even though an administrator filed it — that is the point of it
    check("searching a name narrows it too", pg.evaluate(
        "(rows => rows.length > 0 && rows.length < trailRows.length && rows.every(r => /Rosa/.test(r.textContent)))"
        "([...document.querySelectorAll('#trail-body tr')])"), True)
    pg.fill("#trail-q", ""); pg.wait_for_timeout(300)
    check("clearing the search brings them all back", pg.evaluate("trailRows.length"), before)

    # even an administrator may not rewrite it
    check("an administrator cannot change the trail either", pg.evaluate(
        "(async()=>{const was=JSON.stringify(__DB.lbl_activity.map(r=>r.action));"
        "try{await sb.update('lbl_activity','id=gt.0',{action:'tampered'})}catch(e){}"
        "return JSON.stringify(__DB.lbl_activity.map(r=>r.action))===was ? 'unchanged' : 'TAMPERED'})()"),
        "unchanged")
    check("nor delete from it", pg.evaluate(
        "(async()=>{const n=__DB.lbl_activity.length;"
        "try{await sb.remove('lbl_activity','id=gt.0')}catch(e){}"
        "return __DB.lbl_activity.length===n ? 'all still there' : 'ROWS LOST'})()"),
        "all still there")
    check("and the entries survived the whole run", pg.evaluate("__DB.lbl_activity.length > 10"), True)
    pg.screenshot(path="/home/claude/repo/test/shot-operator.png", full_page=True)
    b.close()

print("\nJS ERRORS:", errs or "none")
print("FAILURES:", fails or "none")
sys.exit(1 if (fails or errs) else 0)
