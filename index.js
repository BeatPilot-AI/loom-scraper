const puppeteer = require('puppeteer');
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

function parseVTT(vttContent) {
  const lines = vttContent.split('\n');
  let transcript = '';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith('WEBVTT') && !line.includes('-->') && !line.match(/^\d+$/)) {
      transcript += line + ' ';
    }
  }
  
  return transcript.trim();
}

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
  await page.waitForTimeout(5000);

  // Get videos with their creation dates
  const videos = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/share/"]'));
    return links.map(link => {
      const url = link.href;
      // Try to find date nearby the link
      const container = link.closest('[data-video-id]') || link.closest('div');
      const dateElement = container?.querySelector('time');
      const dateString = dateElement?.getAttribute('datetime') || dateElement?.textContent;
      
      return {
        url: url,
        date: dateString
      };
    }).filter((item, index, self) => 
      self.findIndex(v => v.url === item.url) === index
    );
  });

  // Filter to last 2 weeks
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  
  const recentVideos = videos.filter(v => {
    if (!v.date) return true; // Include if we can't determine date
    const videoDate = new Date(v.date);
    return videoDate >= twoWeeksAgo;
  });

  console.log(`Found ${videos.length} total videos, ${recentVideos.length} from last 2 weeks`);
  
  let processedCount = 0;

  for (const video of recentVideos) {
    try {
      await page.goto(video.url);
      await page.waitForTimeout(3000);

      const title = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        const pageTitle = document.title;
        const metaTitle = document.querySelector('meta[property="og:title"]');
        
        if (h1 && h1.textContent.trim()) {
          return h1.textContent.trim();
        }
        if (metaTitle && metaTitle.getAttribute('content')) {
          return metaTitle.getAttribute('content').replace(' | Loom', '').trim();
        }
        if (pageTitle && pageTitle !== 'Loom') {
          return pageTitle.replace(' | Loom', '').trim();
        }
        return 'Untitled';
      });

      console.log(`Processing: ${title}`);

      const vttUrl = await page.evaluate(() => {
        const track = document.querySelector('track[kind="captions"]');
        return track ? track.getAttribute('src') : null;
      });

      if (!vttUrl) {
        console.log('❌ No captions/transcript available');
        continue;
      }

      console.log('✓ Found VTT URL, fetching transcript...');
      
      const vttResponse = await page.goto(vttUrl);
      const vttContent = await vttResponse.text();
      const transcript = parseVTT(vttContent);

      console.log(`Transcript length: ${transcript.length} characters`);

      if (transcript && transcript.length > 50) {
        const payload = {
          video_id: video.url.split('/').pop(),
          title: title,
          transcript: transcript,
          video_url: video.url,
          created_at: new Date().toISOString()
        };

        console.log(`Sending to n8n...`);
        
        const response = await fetch(process.env.N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          console.log(`✓ Sent to n8n: ${title}`);
          processedCount++;
        } else {
          console.log(`❌ n8n error: ${response.status} ${response.statusText}`);
        }
      } else {
        console.log('❌ Transcript too short or empty');
      }
    } catch (err) {
      console.error(`Error processing ${video.url}:`, err.message);
    }
  }

  await browser.close();
  console.log(`\n=== Scraping Complete ===`);
  console.log(`Videos processed: ${processedCount}`);
}

app.get('/scrape', async (req, res) => {
  res.json({ status: 'started', message: 'Scraping Loom transcripts...' });
  
  scrapeTranscripts().catch(err => {
    console.error('Scraping error:', err);
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'ready', message: 'Loom scraper is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
