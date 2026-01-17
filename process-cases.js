// Process case.law zip files and add them to cases/json/
// Usage: node process-cases.js

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const ZIP_DIR = path.join(__dirname, 'cases', 'burn after reading');
const OUTPUT_DIR = path.join(__dirname, 'cases', 'json');
const TEMP_DIR = path.join(__dirname, 'cases', 'temp_extract');

// Statistics
const stats = {
    totalZips: 0,
    totalJsonFiles: 0,
    processed: 0,
    added: 0,
    skipped: {
        duplicate: 0,
        invalid: 0,
        tooShort: 0,
        missingFields: 0,
        parseError: 0
    },
    errors: []
};

// Track case IDs to detect duplicates
const seenCaseIds = new Set();

// Load existing case IDs
async function loadExistingCaseIds() {
    console.log('Loading existing case IDs...');
    const files = await fs.readdir(OUTPUT_DIR);
    let count = 0;
    
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        try {
            const filePath = path.join(OUTPUT_DIR, file);
            const content = await fs.readFile(filePath, 'utf8');
            const caseData = JSON.parse(content);
            
            if (caseData.id) {
                seenCaseIds.add(caseData.id);
                count++;
            }
        } catch (error) {
            // Skip invalid files
        }
    }
    
    console.log(`Found ${count} existing cases with IDs`);
    return count;
}

// Find highest case number
async function findHighestCaseNumber() {
    const files = await fs.readdir(OUTPUT_DIR);
    let maxNum = 0;
    
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const match = file.match(/^(\d+)-/);
        if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxNum) {
                maxNum = num;
            }
        }
    }
    
    return maxNum;
}

// Validate case JSON structure
function validateCase(caseData) {
    // Check required fields
    if (!caseData.id) {
        return { valid: false, reason: 'missingFields', message: 'Missing id field' };
    }
    
    if (!caseData.name) {
        return { valid: false, reason: 'missingFields', message: 'Missing name field' };
    }
    
    if (!caseData.casebody) {
        return { valid: false, reason: 'missingFields', message: 'Missing casebody field' };
    }
    
    if (!caseData.casebody.opinions || !Array.isArray(caseData.casebody.opinions)) {
        return { valid: false, reason: 'missingFields', message: 'Missing or invalid opinions array' };
    }
    
    // Check for opinion text
    let totalText = '';
    for (const opinion of caseData.casebody.opinions) {
        if (opinion.text) {
            totalText += opinion.text;
        }
    }
    
    // Minimum text length check (500 characters)
    if (totalText.length < 500) {
        return { valid: false, reason: 'tooShort', message: `Opinion text too short: ${totalText.length} characters` };
    }
    
    return { valid: true };
}

// Process a single JSON file
async function processJsonFile(jsonPath, nextCaseNumber) {
    try {
        const content = await fs.readFile(jsonPath, 'utf8');
        const caseData = JSON.parse(content);
        
        stats.totalJsonFiles++;
        
        // Check for duplicate
        if (caseData.id && seenCaseIds.has(caseData.id)) {
            stats.skipped.duplicate++;
            return { success: false, reason: 'duplicate', caseId: caseData.id };
        }
        
        // Validate case
        const validation = validateCase(caseData);
        if (!validation.valid) {
            stats.skipped[validation.reason]++;
            return { success: false, reason: validation.reason, message: validation.message };
        }
        
        // Generate filename
        const fileName = `${String(nextCaseNumber).padStart(4, '0')}-01.json`;
        const outputPath = path.join(OUTPUT_DIR, fileName);
        
        // Update file_name field to match
        caseData.file_name = fileName.replace('.json', '');
        
        // Write to output directory
        await fs.writeFile(outputPath, JSON.stringify(caseData, null, 2), 'utf8');
        
        // Track this case ID
        if (caseData.id) {
            seenCaseIds.add(caseData.id);
        }
        
        stats.added++;
        return { success: true, fileName, caseId: caseData.id };
        
    } catch (error) {
        stats.skipped.parseError++;
        stats.errors.push({ file: jsonPath, error: error.message });
        return { success: false, reason: 'parseError', message: error.message };
    }
}

// Process a single zip file
async function processZipFile(zipPath, startCaseNumber) {
    try {
        console.log(`Processing ${path.basename(zipPath)}...`);
        const zip = new AdmZip(zipPath);
        const zipEntries = zip.getEntries();
        
        let currentCaseNumber = startCaseNumber;
        let processedInZip = 0;
        
        // Extract to temp directory
        zip.extractAllTo(TEMP_DIR, true);
        
        // Find all JSON files recursively
        async function findJsonFiles(dir) {
            const files = [];
            const entries = await fs.readdir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                
                if (entry.isDirectory()) {
                    const subFiles = await findJsonFiles(fullPath);
                    files.push(...subFiles);
                } else if (entry.isFile() && entry.name.endsWith('.json')) {
                    files.push(fullPath);
                }
            }
            
            return files;
        }
        
        const jsonFiles = await findJsonFiles(TEMP_DIR);
        
        // Process each JSON file
        for (const jsonFile of jsonFiles) {
            const result = await processJsonFile(jsonFile, currentCaseNumber);
            
            if (result.success) {
                currentCaseNumber++;
                processedInZip++;
                stats.processed++;
            }
        }
        
        // Clean up temp directory
        await fs.rm(TEMP_DIR, { recursive: true, force: true });
        await fs.mkdir(TEMP_DIR, { recursive: true });
        
        console.log(`  Added ${processedInZip} cases from ${path.basename(zipPath)}`);
        return currentCaseNumber;
        
    } catch (error) {
        console.error(`Error processing ${path.basename(zipPath)}:`, error.message);
        stats.errors.push({ file: zipPath, error: error.message });
        return startCaseNumber;
    }
}

// Main processing function
async function main() {
    console.log('=== Case Processing Script ===\n');
    
    // Ensure temp directory exists
    await fs.mkdir(TEMP_DIR, { recursive: true });
    
    // Load existing case IDs
    await loadExistingCaseIds();
    
    // Find starting case number
    const highestNum = await findHighestCaseNumber();
    let nextCaseNumber = highestNum + 1;
    console.log(`Starting case number: ${nextCaseNumber}\n`);
    
    // Get all zip files
    const zipFiles = (await fs.readdir(ZIP_DIR))
        .filter(file => file.endsWith('.zip'))
        .map(file => path.join(ZIP_DIR, file))
        .sort();
    
    stats.totalZips = zipFiles.length;
    console.log(`Found ${zipFiles.length} zip files to process\n`);
    
    // Process each zip file
    for (const zipFile of zipFiles) {
        nextCaseNumber = await processZipFile(zipFile, nextCaseNumber);
    }
    
    // Clean up temp directory
    await fs.rm(TEMP_DIR, { recursive: true, force: true });
    
    // Print summary
    console.log('\n=== Processing Summary ===');
    console.log(`Total zip files: ${stats.totalZips}`);
    console.log(`Total JSON files found: ${stats.totalJsonFiles}`);
    console.log(`Successfully added: ${stats.added}`);
    console.log(`Skipped:`);
    console.log(`  - Duplicates: ${stats.skipped.duplicate}`);
    console.log(`  - Invalid structure: ${stats.skipped.invalid}`);
    console.log(`  - Too short: ${stats.skipped.tooShort}`);
    console.log(`  - Missing fields: ${stats.skipped.missingFields}`);
    console.log(`  - Parse errors: ${stats.skipped.parseError}`);
    console.log(`\nNext case number would be: ${nextCaseNumber}`);
    
    if (stats.errors.length > 0) {
        console.log(`\nErrors encountered: ${stats.errors.length}`);
        if (stats.errors.length <= 10) {
            stats.errors.forEach(err => {
                console.log(`  - ${path.basename(err.file)}: ${err.error}`);
            });
        }
    }
    
    console.log('\nDone!');
}

// Run the script
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
