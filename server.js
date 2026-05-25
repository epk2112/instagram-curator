const express = require('express');
const multer = require('multer');
const cheerio = require('cheerio');
const archiverPkg = require('archiver');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// Fix: Robust interop for archiver to handle CommonJS, ESM namespace objects, and updated exports
const archiver = typeof archiverPkg === 'function' ? archiverPkg : (archiverPkg.default || archiverPkg.create);

const app = express();
const PORT = 3000;

// Ensure dirs exist (critical on Windows  multer won't create them)
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const EXPORTS_DIR = path.join(__dirname, 'exports');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Use memory storage  no disk read needed, avoids Windows path issues
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

//  Parser 
function parsePostsHTML(html) {
  const $ = cheerio.load(html, { decodeEntities: true });
  const posts = [];

  $('main > div.pam').each((i, el) => {
    const block = $(el);

    // Caption: text node directly inside the first media td
    let caption = '';
    const firstMediaTd = block.find('td._2piu._a6_r').first();
    if (firstMediaTd.length) {
      // The div right after the <a> img contains the caption text
      const capDiv = firstMediaTd.find('div').filter((_, d) => {
        return $(d).find('img').length === 0 && $(d).text().trim().length > 0;
      }).first();
      caption = capDiv.text().trim();
    }

    // Date: last ._a6-o element
    const dateEl = block.find('._a6-o').last();
    const date = dateEl.text().trim();

    // Media: all linked images/videos
    const media = [];
    const seen = new Set();
    block.find('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (/\.(jpg|jpeg|png|gif|webp|mp4|mov)$/i.test(href) && !seen.has(href)) {
        seen.add(href);
        media.push({
          order: media.length + 1,
          path: href,
          type: /\.(mp4|mov)$/i.test(href) ? 'video' : 'image'
        });
      }
    });

    // Hashtags
    const hashtags = [];
    block.find('h2').each((_, h2) => {
      if ($(h2).text().trim() === 'Hashtags') {
        $(h2).closest('.pam').find('._a6-p').each((_, p) => {
          const tag = $(p).text().trim();
          if (tag && !hashtags.includes(tag)) hashtags.push(tag);
        });
      }
    });

    if (media.length > 0 || caption) {
      posts.push({
        id: `post_${i + 1}`,
        index: i,
        caption,
        date,
        isCarousel: media.length > 1,
        media,
        hashtags
      });
    }
  });

  return posts;
}

//  Routes 

app.post('/api/upload', (req, res) => {
  upload.single('postsFile')(req, res, (multerErr) => {
    if (multerErr) {
      console.error('Multer error:', multerErr);
      return res.status(500).json({ error: 'Upload error: ' + multerErr.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file received' });
    }
    try {
      const html = req.file.buffer.toString('utf-8');
      const posts = parsePostsHTML(html);
      console.log(`Parsed ${posts.length} posts`);
      res.json({ posts, total: posts.length });
    } catch (parseErr) {
      console.error('Parse error:', parseErr);
      res.status(500).json({ error: 'Parse error: ' + parseErr.message });
    }
  });
});

// Export: zip up selected posts + their media + viewer HTML
app.post('/api/export', async (req, res) => {
  try {
    const { posts, outputName = 'instagram_export' } = req.body;
    if (!posts || !Array.isArray(posts)) {
      return res.status(400).json({ error: 'No posts provided' });
    }

    const exportDir = path.join(EXPORTS_DIR, outputName + '_' + Date.now());
    const mediaOut = path.join(exportDir, 'media');
    await fsp.mkdir(mediaOut, { recursive: true });

    // Re-map media paths and attempt to copy files
    const finalPosts = [];
    for (const post of posts) {
      const newMedia = [];
      for (const m of post.media) {
        const ext = path.extname(m.path) || '.jpg';
        const destName = `${post.id}_${m.order}${ext}`;
        const destPath = path.join(mediaOut, destName);

        // Try common locations relative to server root
        const srcRelative = m.path.replace(/^\/+/, '').replace(/\\/g, '/');
        const candidateBases = [
          __dirname,
          path.join(__dirname, '..'),
          path.join(__dirname, '..', '..'),
        ];
        let copied = false;
        for (const base of candidateBases) {
          const src = path.join(base, srcRelative);
          if (fs.existsSync(src)) {
            try {
              await fsp.copyFile(src, destPath);
              copied = true;
            } catch (_) {}
            break;
          }
        }
        newMedia.push({
          ...m,
          exportedPath: `media/${destName}`,
          mediaCopied: copied,
          ...(!copied && { warning: 'media_not_found_locally' })
        });
      }
      finalPosts.push({ ...post, media: newMedia });
    }

    // Write JSON
    await fsp.writeFile(
      path.join(exportDir, 'posts.json'),
      JSON.stringify(finalPosts, null, 2),
      'utf-8'
    );

    // Write standalone viewer
    await fsp.writeFile(
      path.join(exportDir, 'viewer.html'),
      generateViewerHTML(finalPosts, outputName),
      'utf-8'
    );

    // Stream zip back
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${outputName}.zip"`);
    
    // Archiver is safely invoked here due to the robust definition at the top of the file
    const archive = archiver('zip', { zlib: { level: 6 } });
    
    archive.on('error', err => { if (!res.headersSent) res.status(500).end(); console.error(err); });
    archive.pipe(res);
    archive.directory(exportDir, false);
    await archive.finalize();

  } catch (err) {
    console.error('Export error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

//  Viewer HTML 
function generateViewerHTML(posts, title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escHtml(title)}  Archive Viewer</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet"/>
<style>
:root{--bg:#0a0a0a;--surface:#141414;--card:#1c1c1c;--border:#2a2a2a;--accent:#e8c07d;--accent2:#c9a85c;--text:#f0ede8;--muted:#777;--r:12px}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;min-height:100vh}
header{padding:52px 32px 32px;text-align:center;border-bottom:1px solid var(--border)}
header h1{font-family:'Playfair Display',serif;font-size:clamp(1.8rem,4vw,3rem);color:var(--accent);font-style:italic;font-weight:400}
header p{color:var(--muted);margin-top:8px;font-size:13px}
.stats{display:flex;gap:32px;justify-content:center;margin-top:24px}
.stat-n{font-family:'Playfair Display',serif;font-size:2rem;color:var(--accent);display:block}
.stat-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em}
.controls{padding:20px 32px;display:flex;gap:10px;flex-wrap:wrap;max-width:1400px;margin:0 auto}
.search{flex:1;min-width:180px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:9px 14px;color:var(--text);font-family:inherit;font-size:13px;outline:none}
.search:focus{border-color:var(--accent)}
.fbtn{padding:8px 16px;border-radius:20px;border:1px solid var(--border);background:transparent;color:var(--muted);font-family:inherit;font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.04em;cursor:pointer;transition:all .2s}
.fbtn:hover,.fbtn.active{border-color:var(--accent);color:var(--accent);background:rgba(232,192,125,.08)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;padding:0 32px 64px;max-width:1400px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;transition:transform .2s,box-shadow .2s}
.card:hover{transform:translateY(-3px);box-shadow:0 12px 40px rgba(0,0,0,.5)}
.vis{position:relative;aspect-ratio:1;background:#000;overflow:hidden}
.vis img,.vis video{width:100%;height:100%;object-fit:cover;display:none}
.vis img.on,.vis video.on{display:block}
.cnav{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);display:flex;gap:5px}
.cdot{width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.35);cursor:pointer;transition:background .2s}
.cdot.on{background:#fff}
.carr{position:absolute;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.5);border:none;color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s}
.vis:hover .carr{opacity:1}
.carr.p{left:8px}.carr.n{right:8px}
.mbadge{position:absolute;top:8px;right:8px;background:rgba(0,0,0,.65);border-radius:20px;color:#fff;font-size:10px;padding:2px 8px;font-weight:600}
.body{padding:14px}
.date{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:7px}
.cap{font-size:13px;line-height:1.6;color:var(--text);max-height:90px;overflow:hidden;position:relative}
.cap.open{max-height:none}
.cap:not(.open)::after{content:'';position:absolute;bottom:0;left:0;right:0;height:30px;background:linear-gradient(transparent,var(--card))}
.more{font-size:11px;color:var(--accent);cursor:pointer;margin-top:5px;display:inline-block}
.tags{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px}
.tag{font-size:9.5px;color:var(--accent2);background:rgba(232,192,125,.08);border:1px solid rgba(232,192,125,.15);border-radius:20px;padding:2px 7px}
.empty{text-align:center;color:var(--muted);padding:80px;grid-column:1/-1;font-family:'Playfair Display',serif;font-size:1.5rem;font-style:italic}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body>
<header>
  <h1>${escHtml(title)}</h1>
  <p>Curated Instagram Archive</p>
  <div class="stats">
    <div><span class="stat-n">${posts.length}</span><span class="stat-l">Posts</span></div>
    <div><span class="stat-n">${posts.filter(p=>p.isCarousel).length}</span><span class="stat-l">Carousels</span></div>
    <div><span class="stat-n">${posts.reduce((n,p)=>n+p.media.length,0)}</span><span class="stat-l">Media Files</span></div>
  </div>
</header>
<div class="controls">
  <input class="search" id="s" placeholder="Search captions or hashtags"/>
  <button class="fbtn active" data-f="all">All</button>
  <button class="fbtn" data-f="carousel">Carousels</button>
  <button class="fbtn" data-f="single">Single</button>
</div>
<div class="grid" id="g"></div>
<script>
const P=${JSON.stringify(posts)};
let f='all',q='';
function render(){
  const g=document.getElementById('g');
  let pp=P.filter(p=>{
    if(f==='carousel'&&!p.isCarousel)return false;
    if(f==='single'&&p.isCarousel)return false;
    if(q){const ql=q.toLowerCase();return(p.caption||'').toLowerCase().includes(ql)||p.hashtags.some(h=>h.toLowerCase().includes(ql));}
    return true;
  });
  if(!pp.length){g.innerHTML='<div class="empty">No posts found</div>';return;}
  g.innerHTML=pp.map(p=>{
    const med=p.media.map((m,i)=>{
      const s=m.exportedPath||m.path;
      return m.type==='video'?
        \`<video class="\${i===0?'on':''}" src="\${s}" muted playsinline></video>\`:
        \`<img class="\${i===0?'on':''}" src="\${s}" loading="lazy"/>\`;
    }).join('');
    const dots=p.media.length>1?'<div class="cnav">'+p.media.length+'</div>':'';
    const arr=p.media.length>1?'<button class="carr p">&#8249;</button><button class="carr n">&#8250;</button>':'';
    const badge=p.isCarousel?'<div class="mbadge"> '+p.media.length+'</div>':'';
    const cap=(p.caption||'').substring(0,500).replace(/[<>]/g,c=>c==='<'?'&lt;':'&gt;');
    const tags=p.hashtags.length?'<div class="tags">'+p.hashtags.slice(0,10).map(t=>'<span class="tag">#'+t+'</span>').join('')+'</div>':'';
    return \`<div class="card"><div class="vis">\${med}\${dots}\${arr}\${badge}</div><div class="body"><div class="date">\${p.date}</div>\${cap?'<div class="cap">'+cap+'</div><span class="more">Read more</span>':''}\${tags}</div></div>\`;
  }).join('');
  g.querySelectorAll('.vis').forEach(v=>{
    const items=v.querySelectorAll('img,video'),dots=v.querySelectorAll('.cdot');
    if(items.length<2)return;
    let c=0;
    function go(n){items[c].classList.remove('on');dots[c]&&dots[c].classList.remove('on');c=(n+items.length)%items.length;items[c].classList.add('on');dots[c]&&dots[c].classList.add('on');}
    v.querySelector('.p')?.addEventListener('click',e=>{e.stopPropagation();go(c-1);});
    v.querySelector('.n')?.addEventListener('click',e=>{e.stopPropagation();go(c+1);});
    dots.forEach((d,i)=>d.addEventListener('click',e=>{e.stopPropagation();go(i);}));
  });
  g.querySelectorAll('.more').forEach(btn=>btn.addEventListener('click',()=>{
    const cap=btn.previousElementSibling;cap.classList.toggle('open');btn.textContent=cap.classList.contains('open')?'Show less':'Read more';
  }));
}
document.querySelectorAll('.fbtn').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('.fbtn').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');f=b.dataset.f;render();
}));
let t;document.getElementById('s').addEventListener('input',e=>{clearTimeout(t);t=setTimeout(()=>{q=e.target.value;render();},200);});
render();
</script>
</body>
</html>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

app.listen(PORT, () => {
  console.log(`\n  Instagram Curator running  http://localhost:${PORT}\n`);
});