const puppeteer = require('puppeteer');
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

async function scrapeTranscripts() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
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
  await page.waitForTimeout(5000); // Give it more time to load

  const videoLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/share/"]'));
    return links.map(link => ({
      url: link.href,
      title: link.getAttribute('title') || link.textContent.trim() || 'Untitled'
    }));
  });

  console.log(`Found ${videoLinks.length} videos`);

  for (const video of videoLinks) {
    try {
      console.log(`Processing: ${video.title}`);
      await page.goto(video.url);
      await page.waitForTimeout(3000);

      // Take screenshot for debugging
      console.log('Looking for transcript button...');
      
      // Try to click transcript button with multiple strategies
      const transcriptFound = await page.evaluate(() => {
        // Try multiple ways to find and click transcript
        const buttons = Array.from(document.querySelectorAll('button'));
        const transcriptBtn = buttons.find(btn => 
          btn.textContent.toLowerCase().includes('transcript') ||
          btn.getAttribute('aria-label')?.toLowerCase().includes('transcript')
        );
        
        if (transcriptBtn) {
          transcriptBtn.click();
          return true;
        }
        return false;
      });

      if (!transcriptFound) {
        console.log('❌ No transcript button found, skipping...');
        continue;
      }

      console.log('✓ Clicked transcript button, waiting for content...');
      await page.waitForTimeout(3000);

      const transcript = await page.evaluate(() => {
        // Try multiple selectors
        const selectors = [
          '[data-testid="transcript-content"]',
          '[class*="transcript"]',
          '[class*="Transcript"]',
          'div[role="log"]',
          '.transcript-text'
        ];
        
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el && el.innerText && el.innerText.length > 50) {
            return el.innerText;
          }
        }
        
        return '';
      });

      console.log(`Transcript length: ${transcript.length} characters`);

      if (transcript && transcript.length > 50) {
        const payload = {
          video_id: video.url.split('/').pop(),
          title: video.title,
          transcript: transcript,
          video_url: video.url,
          created_at: new Date().toISOString()
        };

        console.log(`Sending to n8n: ${process.env.N8N_WEBHOOK_URL}`);
        
        const response = await fetch(process.env.N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          console.log(`✓ Sent to n8n: ${video.title}`);
        } else {
          console.log(`❌ n8n error: ${response.status} ${response.statusText}`);
        }
      } else {
        console.log('❌ No transcript content found');
      }
    } catch (err) {
      console.error(`Error processing ${video.url}:`, err.message);
    }
  }

  await browser.close();
  console.log('Scraping complete!');
}

// HTTP endpoint to trigger scraping
app.get('/scrape', async (req, res) => {
  res.json({ status: 'started', message: 'Scraping Loom transcripts...' });
  
  // Run scraping in background
  scrapeTranscripts().catch(err => {
    console.error('Scraping error:', err);
  });
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ready', message: 'Loom scraper is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
