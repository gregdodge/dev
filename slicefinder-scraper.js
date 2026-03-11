/**
 * SliceFinder Wayback Machine Scraper
 * ------------------------------------
 * Fetches all archived restaurant URLs from the Wayback CDX API,
 * then scrapes each page for restaurant data and reviews.
 *
 * Usage:
 *   npm install node-fetch cheerio
 *   node slicefinder-scraper.js
 *
 * Output:
 *   restaurants.json  — array of restaurant objects ready for Firestore
 *   reviews.json      — array of review objects ready for Firestore
 *   scrape-log.txt    — log of successes/failures
 */

const fs    = require('fs');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const WAYBACK_CDX_URL =
  'https://web.archive.org/cdx/search/cdx' +
  '?url=slicefinder.com/restaurants/*' +
  '&output=json' +
  '&fl=timestamp,original' +
  '&filter=statuscode:200' +
  '&collapse=urlkey' +        // one snapshot per unique URL
  '&from=20200101' +          // prefer post-2020 snapshots for fresher data
  '&limit=2000';

// Fallback CDX URL if no post-2020 snapshots exist (tries all dates)
const WAYBACK_CDX_FALLBACK =
  'https://web.archive.org/cdx/search/cdx' +
  '?url=slicefinder.com/restaurants/*' +
  '&output=json' +
  '&fl=timestamp,original' +
  '&filter=statuscode:200' +
  '&collapse=urlkey' +
  '&limit=2000';

const WAYBACK_BASE   = 'https://web.archive.org/web';
const DELAY_MS       = 1500;   // be polite to Wayback Machine — 1.5s between requests
const MAX_RETRIES    = 3;
const OUTPUT_DIR     = './';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SliceFinderScraper/1.0)' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function parseStars(text) {
  if (!text) return null;
  const m = text.match(/(\d+(\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function cleanText(str) {
  if (!str) return '';
  return str.replace(/\s+/g, ' ').trim();
}

// ── Star width → rating conversion ───────────────────────────────────────────
// The site encodes star ratings as CSS width on <li class="current-rating">
// e.g. width:45px = 3.0 stars, width:60px = 4.0, width:75px = 5.0
// Formula: rating = width / 15
function widthToRating(widthPx) {
  return Math.round((widthPx / 15) * 10) / 10;
}

// ── Parse a restaurant page ───────────────────────────────────────────────────
function parsePage(html, originalUrl) {
  const restaurant = {
    name: '', address: '', city: '', state: '', zip: '',
    phone: '', hours: '', url: '', lat: null, lng: null,
    tags: [], specifics: {}, sourceUrl: originalUrl,
  };
  const reviews = [];
  let m;

  // ── Name: <h1>Restaurant Name</h1> ───────────────────────────────
  m = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (m) restaurant.name = cleanText(m[1]);

  // ── Lat/Lng: new GPoint(-122.435814,37.798702) ────────────────────
  m = html.match(/new GPoint\(([\-\d.]+),([\-\d.]+)\)/);
  if (m) { restaurant.lng = parseFloat(m[1]); restaurant.lat = parseFloat(m[2]); }

  // ── Address block: plain text lines after star rating comment ─────
  // Pattern: <!-- X stars  --><br/>\nSTREET<br/>\nCITY, STATE ZIP<br/>\nPHONE<br/>
  m = html.match(/<!--[^>]*stars[^>]*-->[\s\S]*?<br\/?>[\s\r\n]*([^<\n\r]+)<br\/?>[\s\r\n]*([^<\n\r]+)<br\/?>[\s\r\n]*([^<\n\r]+)<br\/>/i);
  if (m) {
    restaurant.address = cleanText(m[1]);
    const cityStateZip = cleanText(m[2]);
    const czm = cityStateZip.match(/^(.+),\s*([A-Z]{2})\s*(\d{5})?$/);
    if (czm) { restaurant.city = cleanText(czm[1]); restaurant.state = czm[2]; restaurant.zip = czm[3] || ''; }
    else { restaurant.city = cityStateZip; }
    restaurant.phone = cleanText(m[3]);
  }

  // ── Website: first external nofollow link after phone ─────────────
  const extLinks = html.matchAll(/href=["'](https?:\/\/[^"']+)["'][^>]*rel=["'][^"']*nofollow[^"']*["']/gi);
  for (const el of extLinks) {
    const href = el[1];
    if (!href.includes('web.archive.org') && !href.includes('slicefinder.com') &&
        !href.includes('google.com') && !href.includes('facebook.com') &&
        !href.includes('feedburner') && !href.includes('quantserve') &&
        !href.includes('connect.facebook') && !href.includes('altitude-arena')) {
      restaurant.url = href; break;
    }
  }

  // ── Specifics: <div class="specifics"> yes/no attributes ──────────
  m = html.match(/<div class="specifics">([\s\S]*?)<\/div>/i);
  if (m) {
    const tags = [];
    const specMatches = m[1].matchAll(/<strong>([^<]+):<\/strong>\s*([^<\n]+)/gi);
    const tagMap = { 'thin crust':'Thin Crust','thick crust':'Thick Crust','deep dish':'Deep Dish',
      'delivers':'Delivery','take out':'Take Out','late night':'Late Night',
      'full bar':'Full Bar','waiter service':'Waiter Service','counter only':'Counter Only' };
    for (const sm of specMatches) {
      const key = cleanText(sm[1]).toLowerCase();
      const val = cleanText(sm[2]);
      restaurant.specifics[key] = val;
      if (val === 'yes' && tagMap[key]) tags.push(tagMap[key]);
    }
    restaurant.tags = tags;
  }

  // ── Reviews: <div class="review"> blocks ──────────────────────────
  const reviewBlocks = html.matchAll(/<div class="review">([\s\S]*?)<div style="margin-bottom:12px;">/gi);
  for (const rb of reviewBlocks) {
    const block = rb[1];
    const rev = { username: '', rating: null, text: '', restaurantName: restaurant.name };

    // Username from /person/USERNAME link
    let rm = block.match(/href=["'][^"']*\/person\/[^"'\/]+["'][^>]*>([^<]+)<\/a>/i);
    if (rm) rev.username = cleanText(rm[1]);

    // Rating from CSS width on current-rating li
    rm = block.match(/class=["']current-rating["'][^>]*style=["']width:(\d+)px/i);
    if (!rm) rm = block.match(/style=["']width:(\d+)px[^"']*["'][^>]*class=["']current-rating/i);
    if (rm) rev.rating = widthToRating(parseInt(rm[1]));

    // Review text from .review_body
    rm = block.match(/<div class="review_body">[\s\r\n]*([\s\S]*?)<br\/?>\s*<\/div>/i);
    if (rm) {
      rev.text = cleanText(rm[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
        .replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&nbsp;/g,' '));
    }

    if (rev.username || rev.text) reviews.push(rev);
  }

  return { restaurant, reviews };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const log = [];
  const allRestaurants = [];
  const allReviews = [];

  console.log('Step 1: Fetching URL list from Wayback CDX API…');
  log.push('Fetching CDX URL list: ' + WAYBACK_CDX_URL);

  let cdxData;
  try {
    console.log('Trying post-2020 snapshots first…');
    const res = await fetchUrl(WAYBACK_CDX_URL);
    cdxData = JSON.parse(res.body);
    if (cdxData.length <= 1) {
      // No post-2020 results — fall back to all dates
      console.log('No post-2020 snapshots found, trying all dates…');
      const res2 = await fetchUrl(WAYBACK_CDX_FALLBACK);
      cdxData = JSON.parse(res2.body);
    }
  } catch(e) {
    console.error('Failed to fetch CDX data:', e.message);
    process.exit(1);
  }

  // CDX returns [header, [timestamp, url], [timestamp, url], ...]
  const rows = cdxData.slice(1); // skip header row
  console.log(`Found ${rows.length} archived restaurant URLs.`);
  log.push(`Found ${rows.length} URLs`);

  // Save URL list for reference
  fs.writeFileSync(OUTPUT_DIR + 'url-list.json', JSON.stringify(rows, null, 2));
  console.log('URL list saved to url-list.json');

  console.log('\nStep 2: Scraping each restaurant page…\n');

  for (let i = 0; i < rows.length; i++) {
    const [timestamp, originalUrl] = rows[i];
    const archivedUrl = `${WAYBACK_BASE}/${timestamp}/${originalUrl}`;
    const label = `[${i+1}/${rows.length}] ${originalUrl}`;

    let success = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetchUrl(archivedUrl);
        if (res.status !== 200) {
          throw new Error(`HTTP ${res.status}`);
        }

        const { restaurant, reviews } = parsePage(res.body, originalUrl);

        if (restaurant.name) {
          allRestaurants.push(restaurant);
          reviews.forEach(r => allReviews.push({ ...r, restaurantSourceUrl: originalUrl }));
          console.log(`✅ ${label} — "${restaurant.name}" (${reviews.length} reviews)`);
          log.push(`OK: ${originalUrl} -> ${restaurant.name} (${reviews.length} reviews)`);
          success = true;
          break;
        } else {
          throw new Error('Could not parse restaurant name');
        }
      } catch(e) {
        if (attempt < MAX_RETRIES) {
          console.log(`⚠️  ${label} — attempt ${attempt} failed (${e.message}), retrying…`);
          await sleep(DELAY_MS * 2);
        } else {
          console.log(`❌ ${label} — failed after ${MAX_RETRIES} attempts: ${e.message}`);
          log.push(`FAIL: ${originalUrl} -> ${e.message}`);
        }
      }
    }

    // Save progress every 50 restaurants
    if ((i + 1) % 50 === 0) {
      fs.writeFileSync(OUTPUT_DIR + 'restaurants.json', JSON.stringify(allRestaurants, null, 2));
      fs.writeFileSync(OUTPUT_DIR + 'reviews.json', JSON.stringify(allReviews, null, 2));
      console.log(`\n💾 Progress saved: ${allRestaurants.length} restaurants, ${allReviews.length} reviews\n`);
    }

    await sleep(DELAY_MS);
  }

  // Final save
  fs.writeFileSync(OUTPUT_DIR + 'restaurants.json', JSON.stringify(allRestaurants, null, 2));
  fs.writeFileSync(OUTPUT_DIR + 'reviews.json', JSON.stringify(allReviews, null, 2));
  fs.writeFileSync(OUTPUT_DIR + 'scrape-log.txt', log.join('\n'));

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ Done! Scraped ${allRestaurants.length} restaurants and ${allReviews.length} reviews.`);
  console.log('Output files:');
  console.log('  restaurants.json  — import into Firestore');
  console.log('  reviews.json      — import into Firestore');
  console.log('  scrape-log.txt    — full log');
  console.log('  url-list.json     — all archived URLs found');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(console.error);
