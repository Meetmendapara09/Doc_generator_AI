import express from 'express';
import cors from 'cors';
// import axios from 'axios';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { Octokit } from '@octokit/rest';
import hljs from 'highlight.js';
import { Base64 } from 'js-base64';
import env from 'dotenv';
env.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/build')));

// Initialize Octokit with GitHub token from environment variable
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// Utility function to extract owner and repo from GitHub URL
function parseGitHubUrl(url) {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) throw new Error('Invalid GitHub repository URL');
  return { owner: match[1], repo: match[2] };
}

// Utility function to get file extension
function getFileExtension(filename) {
  return path.extname(filename).substring(1);
}

// Route to get repository structure
app.post('/api/repo-structure', async (req, res) => {
  try {
    const { repoUrl } = req.body;
    const { owner, repo } = parseGitHubUrl(repoUrl);
    
    // Get repository contents (root level)
    const { data: contents } = await octokit.repos.getContent({
      owner,
      repo,
      path: '',
    });
    
    // Get README if it exists
    let readme = null;
    const readmeFile = contents.find(item => 
      item.type === 'file' && 
      item.name.toLowerCase().includes('readme')
    );
    
    if (readmeFile) {
      const { data: readmeData } = await octokit.repos.getContent({
        owner,
        repo,
        path: readmeFile.path,
      });
      
      readme = {
        content: Base64.decode(readmeData.content),
        name: readmeFile.name,
      };
    }
    
    // Format directory structure
    const structure = contents.map(item => ({
      name: item.name,
      path: item.path,
      type: item.type,
      size: item.size,
      download_url: item.download_url,
    }));
    
    res.json({ 
      structure, 
      readme,
      repoInfo: { owner, repo } 
    });
  } catch (error) {
    console.error('Error fetching repository structure:', error);
    res.status(500).json({ error: error.message });
  }
});

// Recursive function to get directory contents
async function getDirectoryContents(owner, repo, path, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return [];
  
  try {
    const { data: contents } = await octokit.repos.getContent({
      owner,
      repo,
      path,
    });
    
    const result = [];
    
    for (const item of contents) {
      if (item.type === 'file') {
        result.push({
          name: item.name,
          path: item.path,
          type: 'file',
          size: item.size,
          download_url: item.download_url,
        });
      } else if (item.type === 'dir') {
        const subItems = await getDirectoryContents(
          owner, repo, item.path, depth + 1, maxDepth
        );
        
        result.push({
          name: item.name,
          path: item.path,
          type: 'dir',
          children: subItems,
        });
      }
    }
    
    return result;
  } catch (error) {
    console.error(`Error fetching contents for ${path}:`, error);
    return [];
  }
}

// Route to get full repository structure recursively
app.post('/api/full-structure', async (req, res) => {
  try {
    const { repoUrl, maxDepth = 3 } = req.body;
    const { owner, repo } = parseGitHubUrl(repoUrl);
    
    const fullStructure = await getDirectoryContents(owner, repo, '', 0, maxDepth);
    
    res.json({ structure: fullStructure, repoInfo: { owner, repo } });
  } catch (error) {
    console.error('Error fetching full repository structure:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get file content
async function getFileContent(owner, repo, path) {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
    });
    
    return Base64.decode(data.content);
  } catch (error) {
    console.error(`Error fetching content for ${path}:`, error);
    return `// Error fetching content for ${path}: ${error.message}`;
  }
}

// Route to generate PDF
app.post('/api/generate-pdf', async (req, res) => {
  try {
    const { 
      repoUrl, 
      options = {
        includeReadme: true,
        includeStructure: true,
        includeFiles: true,
        fileExtensions: [],  // empty means all files
        maxDepth: 3,
        maxFileSize: 100000  // 100KB max file size
      } 
    } = req.body;
    
    const { owner, repo } = parseGitHubUrl(repoUrl);
    
    // Get repo information
    const { data: repoData } = await octokit.repos.get({
      owner,
      repo,
    });
    
    // Create PDF document
    const doc = new PDFDocument({ 
      autoFirstPage: true,
      margin: 50,
      info: {
        Title: `${repoData.name} - GitHub Repository`,
        Author: repoData.owner.login,
        Subject: repoData.description || 'GitHub Repository PDF Export',
      }
    });
    
    // Create output file
    const fileName = `${repoData.name}-${Date.now()}.pdf`;
    const filePath = path.join(__dirname, 'temp', fileName);
    
    // Make sure temp directory exists
    if (!fs.existsSync(path.join(__dirname, 'temp'))) {
      fs.mkdirSync(path.join(__dirname, 'temp'));
    }
    
    const writeStream = fs.createWriteStream(filePath);
    doc.pipe(writeStream);
    
    // Cover page
    doc.fontSize(25).text(`${repoData.name}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(`by ${repoData.owner.login}`, { align: 'center' });
    doc.moveDown();
    
    if (repoData.description) {
      doc.fontSize(12).text(repoData.description, { align: 'center' });
      doc.moveDown();
    }
    
    doc.fontSize(10).text(`Stars: ${repoData.stargazers_count} | Forks: ${repoData.forks_count}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
    doc.moveDown(2);
    
    // Add table of contents header
    doc.addPage();
    doc.fontSize(20).text('Table of Contents', { align: 'center' });
    doc.moveDown();
    
    // Get README if requested
    if (options.includeReadme) {
      try {
        const { data: readmeFiles } = await octokit.repos.getContent({
          owner,
          repo,
          path: '',
        });
        
        const readmeFile = readmeFiles.find(file => 
          file.type === 'file' && file.name.toLowerCase().includes('readme')
        );
        
        if (readmeFile) {
          doc.fontSize(12).text('README', { link: `#readme`, underline: true });
          doc.moveDown(0.5);
        }
      } catch (error) {
        console.error('Error finding README:', error);
      }
    }
    
    // Get full structure if requested
    let fullStructure = [];
    if (options.includeStructure || options.includeFiles) {
      fullStructure = await getDirectoryContents(
        owner, repo, '', 0, options.maxDepth
      );
      
      doc.fontSize(12).text('Repository Structure', { link: '#structure', underline: true });
      doc.moveDown(0.5);
      
      if (options.includeFiles) {
        const printFilesToTOC = (items, indent = 0) => {
          for (const item of items) {
            if (item.type === 'file') {
              // Check if file should be included based on extension filter
              const ext = getFileExtension(item.name);
              if (options.fileExtensions.length === 0 || 
                  options.fileExtensions.includes(ext)) {
                doc.fontSize(10).text(
                  '  '.repeat(indent) + item.name, 
                  { link: `#file-${item.path.replace(/[\/\.]/g, '-')}` }
                );
              }
            } else if (item.type === 'dir' && item.children) {
              doc.fontSize(10).text('  '.repeat(indent) + `📁 ${item.name}/`);
              printFilesToTOC(item.children, indent + 1);
            }
          }
        };
        
        printFilesToTOC(fullStructure);
      }
    }
    
    // Add README content
    if (options.includeReadme) {
      try {
        const { data: readmeFiles } = await octokit.repos.getContent({
          owner,
          repo,
          path: '',
        });
        
        const readmeFile = readmeFiles.find(file => 
          file.type === 'file' && file.name.toLowerCase().includes('readme')
        );
        
        if (readmeFile) {
          doc.addPage();
          doc.fontSize(20).text('README', { 
            align: 'center',
            destination: 'readme'
          });
          doc.moveDown();
          
          const readmeContent = await getFileContent(owner, repo, readmeFile.path);
          doc.fontSize(10).text(readmeContent);
        }
      } catch (error) {
        console.error('Error adding README to PDF:', error);
      }
    }
    
    // Add structure visualization
    if (options.includeStructure) {
      doc.addPage();
      doc.fontSize(20).text('Repository Structure', { 
        align: 'center',
        destination: 'structure'
      });
      doc.moveDown();
      
      const printStructure = (items, indent = 0) => {
        for (const item of items) {
          if (item.type === 'file') {
            doc.fontSize(10).text('  '.repeat(indent) + `📄 ${item.name}`);
          } else if (item.type === 'dir' && item.children) {
            doc.fontSize(10).text('  '.repeat(indent) + `📁 ${item.name}/`);
            printStructure(item.children, indent + 1);
          }
        }
      };
      
      printStructure(fullStructure);
    }
    
    // Add file contents
    if (options.includeFiles) {
      const processFiles = async (items) => {
        for (const item of items) {
          if (item.type === 'file') {
            // Check if file should be included based on extension filter
            const ext = getFileExtension(item.name);
            if (options.fileExtensions.length === 0 || 
                options.fileExtensions.includes(ext)) {
              
              // Check file size
              if (item.size <= options.maxFileSize) {
                doc.addPage();
                doc.fontSize(16).text(item.path, { 
                  align: 'center',
                  destination: `file-${item.path.replace(/[\/\.]/g, '-')}`
                });
                doc.moveDown();
                
                const content = await getFileContent(owner, repo, item.path);
                
                // Try to apply syntax highlighting
                try {
                  const highlighted = hljs.highlightAuto(content).value;
                  doc.fontSize(9).text(highlighted);
                } catch (error) {
                  // Fallback to plain text if highlighting fails
                  doc.fontSize(9).text(content);
                }
              } else {
                doc.addPage();
                doc.fontSize(16).text(item.path, { 
                  align: 'center',
                  destination: `file-${item.path.replace(/[\/\.]/g, '-')}`
                });
                doc.moveDown();
                doc.fontSize(10).text(`[File too large to include: ${Math.round(item.size/1024)}KB]`);
              }
            }
          } else if (item.type === 'dir' && item.children) {
            await processFiles(item.children);
          }
        }
      };
      
      await processFiles(fullStructure);
    }
    
    // Finalize PDF
    doc.end();
    
    // Wait for the PDF to be fully written
    writeStream.on('finish', () => {
      // Send the PDF file
      res.download(filePath, fileName, (err) => {
        if (err) {
          console.error('Error sending PDF:', err);
        }
        
        // Clean up the temporary file
        fs.unlink(filePath, (unlinkErr) => {
          if (unlinkErr) {
            console.error('Error deleting temporary file:', unlinkErr);
          }
        });
      });
    });
    
    writeStream.on('error', (error) => {
      console.error('Error writing PDF file:', error);
      res.status(500).json({ error: 'Failed to generate PDF' });
    });
    
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ error: error.message });
  }
});

// Catch-all handler for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;