# Instagram Post Curator

A local Node.js web app for reviewing, curating, and exporting your Instagram backup posts.

## Setup

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

## How It Works

### 1. Upload
Drop your `posts.html` from your Instagram data export onto the upload zone.  
The app parses all posts (captions, media paths, hashtags, dates) instantly.

### 2. Curate
- **Click any post** to toggle it excluded (dimmed with ✕). Click again to restore it.
- Use the **filter pills** to view All / Carousels / Single / Kept / Excluded
- **Search** captions and hashtags in real time
- Switch between **grid** and **list** view
- **Sort** by date, caption length, or media count
- Use **"Select All Visible"** to bulk-exclude the current filtered view

### 3. Export
Click **Export ↓** when done. You'll get a `.zip` file containing:

```
my_instagram_posts/
├── posts.json        ← structured JSON with all kept posts
├── viewer.html       ← standalone viewer for the exported posts
└── media/            ← copies of all media files, renamed & organized
    ├── post_1_1.jpg
    ├── post_1_2.jpg  (carousel item 2)
    ├── post_2_1.jpg
    └── ...
```

### posts.json Structure

```json
[
  {
    "id": "post_1",
    "caption": "Full caption text…",
    "date": "May 20, 2026 5:56 am",
    "isCarousel": true,
    "media": [
      { "order": 1, "path": "media/posts/...", "type": "image", "exportedPath": "media/post_1_1.jpg" },
      { "order": 2, "path": "media/posts/...", "type": "image", "exportedPath": "media/post_1_2.jpg" }
    ],
    "hashtags": ["perfumes", "tanzania", "essentials"]
  }
]
```

### viewer.html
A self-contained dark-themed viewer for your exported posts — with search, filtering, and carousel support. Open it directly in a browser (no server needed) as long as the `media/` folder is in the same directory.

## Notes

- Your Instagram `media/posts/` folder must be in the same directory structure as the original `posts.html` for media copying to work during export.
- If media files can't be found locally, the JSON will still be exported with the original relative paths and a `warning` flag on affected items.
- The app runs entirely on your machine — no data is sent anywhere.
