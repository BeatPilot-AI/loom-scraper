const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function scrapeTranscripts() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  console.log('Logging into Loom...');
  await page.goto('https://www.loom.com/login');
  await page.waitForSelector('input[type="email"]');
  await page.type('input[type="email"]', process.env.LOOM_EMAIL);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);
  await page.type('input[type="password"]', process.env.LOOM_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForNavigation();

  console.log('Navigating to videos...');
  await page.goto('https://www.loom.com/my-videos');
  await page.waitForTimeout(3000);

  const videoLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/share/"]'));
    return links.map(link => ({
      url: link.href,
      title: link.closest('[data-video-id]')?.querySelector('h3')?.textContent || 'Untitled'
    }));
  });

  console.log(`Found ${videoLinks.length} videos`);

  for (const video of videoLinks) {
    try {
      console.log(`Processing: ${video.title}`);
      await page.goto(video.url);
      await page.waitForTimeout(2000);

      await page.click('button[aria-label="Transcript"]');
      await page.waitForTimeout(1000);

      const transcript = await page.evaluate(() => {
        const transcriptDiv = document.querySelector('[data-testid="transcript-content"]');
        return transcriptDiv?.innerText || '';
      });

      if (transcript) {
        const { error } = await supabase
          .from('loom_transcripts')
          .upsert({
            video_id: video.url.split('/').pop(),
            title: video.title,
            transcript: transcript,
            video_url: video.url,
            created_at: new Date().toISOString(),
            processed: false
          }, { onConflict: 'video_id' });

        if (error) {
          console.error('Supabase error:', error);
        } else {
          console.log(`✓ Saved: ${video.title}`);
        }
      }
    } catch (err) {
      console.error(`Error processing ${video.url}:`, err);
    }
  }

  await browser.close();
  console.log('Scraping complete!');
}

scrapeTranscripts();
