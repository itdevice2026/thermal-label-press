"""Drives the online app against the mock server: auth, roles, CRUD, printing."""
from playwright.sync_api import sync_playwright
from PIL import Image
import zxingcpp, subprocess, glob, os, sys
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

    # customers + products via the UI
    pg.click('[data-tab="customers"]'); pg.wait_for_timeout(200)
    pg.fill("#c-name","Hard Discount Philippines,Inc."); pg.fill("#c-code","DALI")
    pg.click("#b-cadd"); pg.wait_for_timeout(400)
    pg.fill("#c-name","AllJoy Foods"); pg.fill("#c-code","ALLJOY"); pg.fill("#c-w","60"); pg.fill("#c-h","40")
    pg.click("#b-cadd"); pg.wait_for_timeout(500)
    check("customers in db", pg.evaluate("__DB.lbl_customers.map(c=>c.name+'/'+c.code)"),
          ["Hard Discount Philippines,Inc./DALI","AllJoy Foods/ALLJOY"])
    check("customer stock saved", pg.evaluate("!!__DB.lbl_customers.find(c=>c.code=='ALLJOY').stock"), True)

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
    pg.select_option("#f-pick", label="AllJoy Chicken Liver · 500g"); pg.wait_for_timeout(300)
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

    # settings are shared
    pg.click('[data-tab="setup"]'); pg.wait_for_timeout(200)
    pg.fill("#s-dark","18"); pg.wait_for_timeout(500)
    check("house settings saved", pg.evaluate("__DB.lbl_settings[0].data.dark"), 18)

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
    rosa = pg.evaluate("profiles.find(p=>p.name==='Rosa dela Cruz').id")
    pg.select_option(f'.rowrole[data-id="{rosa}"]', "operator"); pg.wait_for_timeout(500)
    check("role updated", pg.evaluate("__DB.lbl_profiles.find(p=>p.name==='Rosa dela Cruz').role"), "operator")

    # operator: can print, cannot administer
    pg.click("#b-signout"); pg.wait_for_timeout(600)
    pg.fill("#li-email","rosa@meatplus.ph"); pg.fill("#li-pass","labelpress2")
    pg.click("#login-panel button[type=submit]"); pg.wait_for_timeout(900)
    check("operator signed in", pg.inner_text("#who-role").lower(), "operator")
    check("operator tabs", pg.eval_on_selector_all(".tabs button","e=>e.filter(x=>x.offsetParent!==null).map(x=>x.textContent)"),
          ["Print","Print log"])
    check("operator sees the shared products", pg.evaluate("catalog.length"), 1)
    pg.evaluate("window.print=()=>{}"); pg.click("#b-print"); pg.wait_for_timeout(600)
    check("operator print logged under her name", pg.evaluate("__DB.lbl_print_log[__DB.lbl_print_log.length-1].by_name"), "Rosa dela Cruz")
    check("operator cannot write products",
          pg.evaluate("(async()=>{try{await sb.insert('lbl_products',[{name:'x',code:'1',customer_id:null}]);return 'ALLOWED'}catch(e){return 'blocked'}})()"),
          "blocked")

    # session survives reload
    pg.reload(); pg.wait_for_timeout(1000)
    check("session survives reload", pg.inner_text("#who-name"), "Rosa dela Cruz")
    pg.screenshot(path="/home/claude/repo/test/shot-operator.png", full_page=True)
    b.close()

print("\nJS ERRORS:", errs or "none")
print("FAILURES:", fails or "none")
sys.exit(1 if (fails or errs) else 0)
