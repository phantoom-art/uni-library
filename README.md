#  UMBB S3 Library

An open-source, high-performance PDF search engine built for university students. Find Courses (Cours), Tutorials (TD), Practicals (TP), and Past Exams in seconds.

**Live Demo:** [https://phantoom-art.github.io/uni-library/](https://phantoom-art.github.io/uni-library/)

---

##  Features

- **Instant Search:** Fuzzy matching across titles and filenames. Type a module name, file name, or type to find exactly what you need.
- **Smart Filters:** Filter documents by Type (Cours, TD, TP, Exams) and by Module (Algorithm, Architecture, etc.).
- **Favorites System:** Star your most-used PDFs to save them locally on your device. No account or login required.
- **Direct Download:** Download PDFs with a single click.
- **Dark / Light Mode:** A beautifully animated theme toggle with a circular reveal effect.
- **Premium UI:** Editorial, library design with a dynamic background that reacts to your cursor.
- **100% Free & Open Source:** No ads, no tracking, no paywalls.

---

## Tech Stack

- **Frontend:** Vanilla HTML, CSS, JavaScript (No frameworks, no build step).
- **File Storage:** Cloudflare R2 (Zero egress fees, fast global CDN).
- **Hosting:** GitHub Pages.
- **Data:** A JSON-based `unipdfs.json` metadata file.

---

## How to Run Locally

Since the site fetches data from a JSON file, you need a local server to avoid browser CORS errors.

1. Clone the repository:
   ```bash
   git clone https://github.com/phantoom-art/uni-library.git
   cd uni-library
