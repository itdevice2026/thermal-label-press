#!/bin/sh
# Rebuilds test/index.html from the real index.html: same markup, same scripts,
# only the Supabase client swapped for the mock and the asset paths lifted one
# directory. Run this after touching index.html, or the tests will be driving
# yesterday's page.
cd "$(dirname "$0")/.." || exit 1
sed -e 's|href="styles.css"|href="../styles.css"|' \
    -e 's|src="js/|src="../js/|g' \
    -e 's|href="handbook.html"|href="../handbook.html"|g' \
    -e 's|src="meatplus.webp"|src="../meatplus.webp"|g' \
    -e 's|src="config.js"|src="../config.js"|' \
    -e 's|src="supabase-lite.js"|src="mock-sb.js"|' \
    index.html > test/index.html
echo "test/index.html rebuilt"
