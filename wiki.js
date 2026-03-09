/**
 * wiki.js -- Data access layer for the wiki functionality
 */

const fs = require('fs').promises;
const path = require('path');
const matter = require('gray-matter');

const WIKI_PATH = path.join(__dirname, 'wiki');
const WORDS_PATH = path.join(WIKI_PATH, 'words');
const TAGS_PATH = path.join(WIKI_PATH, 'tags');
const IMAGES_PATH = path.join(WIKI_PATH, 'images'); // Added IMAGES_PATH

/**
 * Ensures that the necessary wiki directories exist.
 */
async function ensureWikiDirectories() {
  await fs.mkdir(WORDS_PATH, { recursive: true });
  await fs.mkdir(TAGS_PATH, { recursive: true });
  await fs.mkdir(IMAGES_PATH, { recursive: true });
}

// Call it once when the module loads
ensureWikiDirectories().catch(console.error);

/**
 * Creates a URL- and filename-safe slug from a given text.
 * Handles Japanese characters by keeping them, and replacing problematic characters with hyphens.
 * @param {string} text The text to slugify.
 * @returns {string} The slugified text.
 */
function slugify(text) {
  return text
    .toString()
    .trim()
    .replace(/[\s\/\?#%&]+/g, '-') // Replace spaces, slashes, etc. with a single hyphen
    .replace(/[^a-zA-Z0-9\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uFF00-\uFFEF\u4E00-\u9FAF\u3400-\u4DBF-]+/g, '') // Remove characters not in allowed ranges
    .replace(/--+/g, '-'); // Replace multiple hyphens with a single hyphen
}

/**
 * Retrieves a word page.
 * @param {string} word The slugified word.
 * @returns {object | null} The parsed word page data or null if not found.
 */
async function getWordPage(word) {
  const filePath = path.join(WORDS_PATH, `${word}.md`);
  try {
    const fileContent = await fs.readFile(filePath, 'utf8');
    const { data, content } = matter(fileContent);
    return {
      word,
      ...data,
      notes: content,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // File doesn't exist
    }
    throw error;
  }
}

/**
 * Saves a word page, and ensures corresponding tag pages exist.
 * @param {string} word The slugified word.
 * @param {object} pageData The data to save.
 */
async function saveWordPage(word, pageData) {
  const { notes, ...frontMatter } = pageData;
  const fileContent = matter.stringify(notes || '', frontMatter);
  const filePath = path.join(WORDS_PATH, `${word}.md`);
  await fs.writeFile(filePath, fileContent, 'utf8');

  // Ensure tag files exist and update their modification time
  if (frontMatter.tags && Array.isArray(frontMatter.tags)) {
    for (const tag of frontMatter.tags) {
      const tagFilePath = path.join(TAGS_PATH, `${tag}.md`);
      try {
        // "touch" the file to update mtime
        const now = new Date();
        await fs.utimes(tagFilePath, now, now);
      } catch (error) {
        if (error.code === 'ENOENT') {
          // if it doesn't exist, create it
          const defaultTagContent = matter.stringify(`# ${tag}\n\n`, {});
          await fs.writeFile(tagFilePath, defaultTagContent, 'utf8');
        } else {
          throw error;
        }
      }
    }
  }
}

/**
 * Gets all unique tags from all word pages.
 * @returns {Promise<string[]>} A list of unique tags.
 */
async function getAllTags() {
  const files = await fs.readdir(WORDS_PATH);
  const allTags = new Set();

  for (const file of files) {
    if (path.extname(file) === '.md') {
      const filePath = path.join(WORDS_PATH, file);
      const fileContent = await fs.readFile(filePath, 'utf8');
      const { data } = matter(fileContent);
      if (data.tags && Array.isArray(data.tags)) {
        data.tags.forEach(tag => allTags.add(tag));
      }
    }
  }

  return Array.from(allTags).sort();
}

/**
 * Gets lists of words and tags sorted by creation and modification date.
 * @returns {Promise<object>} An object containing the four sorted lists.
 */
async function getWikiIndexData() {
  async function getDirStats(dirPath) {
    const files = await fs.readdir(dirPath);
    const stats = [];
    for (const file of files) {
      if (path.extname(file) === '.md') {
        const stat = await fs.stat(path.join(dirPath, file));
        stats.push({
          name: path.basename(file, '.md'),
          mtime: stat.mtime,
          birthtime: stat.birthtime,
        });
      }
    }
    return stats;
  }

  const wordStats = await getDirStats(WORDS_PATH);
  const tagStats = await getDirStats(TAGS_PATH);

  const sortBy = (key) => (a, b) => b[key].getTime() - a[key].getTime();

  return {
    wordsByModified: wordStats.sort(sortBy('mtime')).slice(0, 20),
    wordsByCreated: wordStats.sort(sortBy('birthtime')).slice(0, 20),
    tagsByModified: tagStats.sort(sortBy('mtime')).slice(0, 20),
    tagsByCreated: tagStats.sort(sortBy('birthtime')).slice(0, 20),
  };
}

async function getTagPage(tagName) {
  const filePath = path.join(TAGS_PATH, `${tagName}.md`);
  try {
    const fileContent = await fs.readFile(filePath, 'utf8');
    const { data, content } = matter(fileContent);
    return {
      name: tagName,
      ...data,
      notes: content,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function getWordsForTag(tagName) {
  const words = [];
  const files = await fs.readdir(WORDS_PATH);
  for (const file of files) {
    if (path.extname(file) === '.md') {
      const filePath = path.join(WORDS_PATH, file);
      const fileContent = await fs.readFile(filePath, 'utf8');
      const { data } = matter(fileContent);
      if (data.tags && data.tags.includes(tagName)) {
        words.push({
          name: path.basename(file, '.md'),
        });
      }
    }
  }
  return words;
}

async function saveTagPage(tagName, pageData) {
  const { notes, ...frontMatter } = pageData;
  const fileContent = matter.stringify(notes || '', frontMatter);
  const filePath = path.join(TAGS_PATH, `${tagName}.md`);
  await fs.writeFile(filePath, fileContent, 'utf8');
}

module.exports = {
  slugify,
  getWordPage,
  saveWordPage,
  getAllTags,
  getWikiIndexData,
  getTagPage,
  getWordsForTag,
  saveTagPage,
};