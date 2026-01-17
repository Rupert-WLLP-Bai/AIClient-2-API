#!/usr/bin/env node

/**
 * Stats Database Error Analysis Script
 *
 * Analyzes data/stats.db to identify:
 * - Failed model requests
 * - Error code distribution
 * - Error patterns by provider and model
 *
 * Usage:
 *   node scripts/analyze-stats-errors.js [options]
 *
 * Options:
 *   --days <n>        Analyze last N days (default: 7)
 *   --limit <n>       Limit results per category (default: 10)
 *   --model <name>    Filter by specific model
 *   --provider <type> Filter by provider type
 *   --json            Output as JSON
 *   --export <file>   Export results to file
 */

import Database from 'better-sqlite3';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';

// ============================================================================
// Configuration and Constants
// ============================================================================

const DB_PATH = join(process.cwd(), 'data', 'stats.db');

// ============================================================================
// Command-line Argument Parsing
// ============================================================================

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        days: 7,
        limit: 10,
        model: null,
        provider: null,
        json: false,
        export: null
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--days' && i + 1 < args.length) {
            options.days = parseInt(args[++i], 10);
        } else if (arg === '--limit' && i + 1 < args.length) {
            options.limit = parseInt(args[++i], 10);
        } else if (arg === '--model' && i + 1 < args.length) {
            options.model = args[++i];
        } else if (arg === '--provider' && i + 1 < args.length) {
            options.provider = args[++i];
        } else if (arg === '--json') {
            options.json = true;
        } else if (arg === '--export' && i + 1 < args.length) {
            options.export = args[++i];
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }
    }

    return options;
}

function printHelp() {
    console.log(`
Stats Database Error Analysis Script

Usage:
  node scripts/analyze-stats-errors.js [options]

Options:
  --days <n>        Analyze last N days (default: 7)
  --limit <n>       Limit results per category (default: 10)
  --model <name>    Filter by specific model
  --provider <type> Filter by provider type
  --json            Output as JSON
  --export <file>   Export results to file
  --help, -h        Show this help message

Examples:
  node scripts/analyze-stats-errors.js
  node scripts/analyze-stats-errors.js --days 30 --limit 20
  node scripts/analyze-stats-errors.js --model claude-opus-4-5
  node scripts/analyze-stats-errors.js --provider claude-kiro-oauth
  node scripts/analyze-stats-errors.js --json --export results.json
`);
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatNumber(num) {
    return num.toLocaleString('en-US');
}

function formatPercentage(value) {
    return `${(value * 100).toFixed(1)}%`;
}

function truncateString(str, maxLength = 60) {
    if (!str) return 'N/A';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
}

function getDateFilter(days) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString();
}

// ============================================================================
// Database Query Functions
// ============================================================================

function getSummary(db, options) {
    const dateFilter = getDateFilter(options.days);

    let whereClause = `WHERE timestamp >= ?`;
    const params = [dateFilter];

    if (options.model) {
        whereClause += ` AND model = ?`;
        params.push(options.model);
    }

    if (options.provider) {
        whereClause += ` AND provider_type = ?`;
        params.push(options.provider);
    }

    const query = `
        SELECT
            COUNT(*) as total_requests,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as total_errors,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as total_success
        FROM request_logs
        ${whereClause}
    `;

    const result = db.prepare(query).get(...params);

    return {
        period: `${options.days} days`,
        totalRequests: result.total_requests || 0,
        totalErrors: result.total_errors || 0,
        totalSuccess: result.total_success || 0,
        errorRate: result.total_requests > 0 ? result.total_errors / result.total_requests : 0
    };
}

function analyzeErrorCodes(db, options) {
    const dateFilter = getDateFilter(options.days);

    let whereClause = `WHERE status = 'error' AND timestamp >= ?`;
    const params = [dateFilter];

    if (options.model) {
        whereClause += ` AND model = ?`;
        params.push(options.model);
    }

    if (options.provider) {
        whereClause += ` AND provider_type = ?`;
        params.push(options.provider);
    }

    const query = `
        SELECT
            status_code,
            COUNT(*) as count
        FROM request_logs
        ${whereClause}
        GROUP BY status_code
        ORDER BY count DESC
        LIMIT ?
    `;

    params.push(options.limit);

    const results = db.prepare(query).all(...params);
    const totalErrors = results.reduce((sum, row) => sum + row.count, 0);

    return results.map(row => ({
        statusCode: row.status_code || 'Unknown',
        count: row.count,
        percentage: totalErrors > 0 ? row.count / totalErrors : 0
    }));
}

function analyzeFailedModels(db, options) {
    const dateFilter = getDateFilter(options.days);

    let whereClause = `WHERE timestamp >= ?`;
    const params = [dateFilter];

    if (options.model) {
        whereClause += ` AND model = ?`;
        params.push(options.model);
    }

    if (options.provider) {
        whereClause += ` AND provider_type = ?`;
        params.push(options.provider);
    }

    const query = `
        SELECT
            model,
            COUNT(*) as total,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success
        FROM request_logs
        ${whereClause}
        GROUP BY model
        HAVING total > 0
        ORDER BY (CAST(errors AS REAL) / total) DESC
        LIMIT ?
    `;

    params.push(options.limit);

    const results = db.prepare(query).all(...params);

    return results.map(row => ({
        model: row.model || 'Unknown',
        errors: row.errors || 0,
        success: row.success || 0,
        total: row.total,
        failureRate: row.total > 0 ? row.errors / row.total : 0
    }));
}

function analyzeErrorMessages(db, options) {
    const dateFilter = getDateFilter(options.days);

    let whereClause = `WHERE status = 'error' AND timestamp >= ? AND error_message IS NOT NULL`;
    const params = [dateFilter];

    if (options.model) {
        whereClause += ` AND model = ?`;
        params.push(options.model);
    }

    if (options.provider) {
        whereClause += ` AND provider_type = ?`;
        params.push(options.provider);
    }

    const query = `
        SELECT
            error_message,
            COUNT(*) as count
        FROM request_logs
        ${whereClause}
        GROUP BY error_message
        ORDER BY count DESC
        LIMIT ?
    `;

    params.push(options.limit);

    const results = db.prepare(query).all(...params);

    return results.map(row => ({
        message: row.error_message,
        count: row.count
    }));
}

function analyzeProviderErrors(db, options) {
    const dateFilter = getDateFilter(options.days);

    let whereClause = `WHERE timestamp >= ?`;
    const params = [dateFilter];

    if (options.model) {
        whereClause += ` AND model = ?`;
        params.push(options.model);
    }

    if (options.provider) {
        whereClause += ` AND provider_type = ?`;
        params.push(options.provider);
    }

    const query = `
        SELECT
            provider_type,
            provider_uuid,
            COUNT(*) as total,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success
        FROM request_logs
        ${whereClause}
        GROUP BY provider_type, provider_uuid
        HAVING total > 0
        ORDER BY (CAST(errors AS REAL) / total) DESC
        LIMIT ?
    `;

    params.push(options.limit);

    const results = db.prepare(query).all(...params);

    return results.map(row => ({
        providerType: row.provider_type || 'Unknown',
        providerUuid: row.provider_uuid || 'Unknown',
        errors: row.errors || 0,
        success: row.success || 0,
        total: row.total,
        errorRate: row.total > 0 ? row.errors / row.total : 0
    }));
}

function analyzeTimeBasedErrors(db, options) {
    const dateFilter = getDateFilter(options.days);

    let whereClause = `WHERE status = 'error' AND timestamp >= ?`;
    const params = [dateFilter];

    if (options.model) {
        whereClause += ` AND model = ?`;
        params.push(options.model);
    }

    if (options.provider) {
        whereClause += ` AND provider_type = ?`;
        params.push(options.provider);
    }

    const query = `
        SELECT
            DATE(timestamp) as date,
            COUNT(*) as count
        FROM request_logs
        ${whereClause}
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
        LIMIT ?
    `;

    params.push(options.limit);

    const results = db.prepare(query).all(...params);

    return results.map(row => ({
        date: row.date,
        count: row.count
    }));
}

function analyzeCombinedPatterns(db, options) {
    const dateFilter = getDateFilter(options.days);

    let whereClause = `WHERE status = 'error' AND timestamp >= ?`;
    const params = [dateFilter];

    if (options.model) {
        whereClause += ` AND model = ?`;
        params.push(options.model);
    }

    if (options.provider) {
        whereClause += ` AND provider_type = ?`;
        params.push(options.provider);
    }

    const query = `
        SELECT
            model,
            status_code,
            COUNT(*) as count
        FROM request_logs
        ${whereClause}
        GROUP BY model, status_code
        ORDER BY count DESC
        LIMIT ?
    `;

    params.push(options.limit);

    const results = db.prepare(query).all(...params);

    return results.map(row => ({
        model: row.model || 'Unknown',
        statusCode: row.status_code || 'Unknown',
        count: row.count
    }));
}

// ============================================================================
// Output Formatting Functions
// ============================================================================

function printConsoleOutput(analysisResults) {
    const { summary, errorCodes, failedModels, errorMessages, providers, timeBased, combined } = analysisResults;

    console.log('\n' + '='.repeat(80));
    console.log('Stats Database Error Analysis');
    console.log('='.repeat(80));
    console.log(`Analysis Period: Last ${summary.period}`);
    console.log(`Total Requests: ${formatNumber(summary.totalRequests)}`);
    console.log(`Total Errors: ${formatNumber(summary.totalErrors)} (${formatPercentage(summary.errorRate)})`);
    console.log(`Total Success: ${formatNumber(summary.totalSuccess)}`);
    console.log('='.repeat(80));

    // Error Codes Distribution
    if (errorCodes.length > 0) {
        console.log('\n--- Error Codes Distribution ---');
        console.log('Status Code | Count      | Percentage');
        console.log('------------|------------|------------');
        errorCodes.forEach(row => {
            console.log(
                `${String(row.statusCode).padEnd(11)} | ` +
                `${formatNumber(row.count).padEnd(10)} | ` +
                `${formatPercentage(row.percentage)}`
            );
        });
    } else {
        console.log('\n--- Error Codes Distribution ---');
        console.log('No error codes found in the specified period.');
    }

    // Failed Models Analysis
    if (failedModels.length > 0) {
        console.log('\n--- Failed Models Analysis ---');
        console.log('Model                          | Errors     | Success    | Total      | Failure Rate');
        console.log('-------------------------------|------------|------------|------------|-------------');
        failedModels.forEach(row => {
            console.log(
                `${truncateString(row.model, 30).padEnd(30)} | ` +
                `${formatNumber(row.errors).padEnd(10)} | ` +
                `${formatNumber(row.success).padEnd(10)} | ` +
                `${formatNumber(row.total).padEnd(10)} | ` +
                `${formatPercentage(row.failureRate)}`
            );
        });
    } else {
        console.log('\n--- Failed Models Analysis ---');
        console.log('No model data found in the specified period.');
    }

    // Top Error Messages
    if (errorMessages.length > 0) {
        console.log('\n--- Top Error Messages ---');
        errorMessages.forEach((row, index) => {
            console.log(`${index + 1}. ${truncateString(row.message, 70)} (${formatNumber(row.count)} occurrences)`);
        });
    } else {
        console.log('\n--- Top Error Messages ---');
        console.log('No error messages found in the specified period.');
    }

    // Provider Error Analysis
    if (providers.length > 0) {
        console.log('\n--- Provider Error Analysis ---');
        console.log('Provider Type          | UUID (first 8) | Errors     | Total      | Error Rate');
        console.log('-----------------------|----------------|------------|------------|------------');
        providers.forEach(row => {
            const uuidShort = row.providerUuid.substring(0, 8);
            console.log(
                `${truncateString(row.providerType, 22).padEnd(22)} | ` +
                `${uuidShort.padEnd(14)} | ` +
                `${formatNumber(row.errors).padEnd(10)} | ` +
                `${formatNumber(row.total).padEnd(10)} | ` +
                `${formatPercentage(row.errorRate)}`
            );
        });
    } else {
        console.log('\n--- Provider Error Analysis ---');
        console.log('No provider data found in the specified period.');
    }

    // Time-based Error Trends
    if (timeBased.length > 0) {
        console.log('\n--- Daily Error Trends ---');
        console.log('Date       | Error Count');
        console.log('-----------|------------');
        timeBased.forEach(row => {
            console.log(`${row.date} | ${formatNumber(row.count)}`);
        });
    }

    // Combined Patterns (Model + Status Code)
    if (combined.length > 0) {
        console.log('\n--- Model + Error Code Patterns ---');
        console.log('Model                          | Status Code | Count');
        console.log('-------------------------------|-------------|------------');
        combined.forEach(row => {
            console.log(
                `${truncateString(row.model, 30).padEnd(30)} | ` +
                `${String(row.statusCode).padEnd(11)} | ` +
                `${formatNumber(row.count)}`
            );
        });
    }

    console.log('\n' + '='.repeat(80));
    console.log('Analysis Complete');
    console.log('='.repeat(80) + '\n');
}

function formatJsonOutput(analysisResults) {
    return JSON.stringify(analysisResults, null, 2);
}

// ============================================================================
// Main Execution
// ============================================================================

function main() {
    try {
        // Parse command-line arguments
        const options = parseArgs();

        // Check if database exists
        if (!existsSync(DB_PATH)) {
            console.error(`Error: Database not found at ${DB_PATH}`);
            process.exit(1);
        }

        // Open database in read-only mode
        const db = new Database(DB_PATH, { readonly: true });

        // Run all analyses
        const analysisResults = {
            summary: getSummary(db, options),
            errorCodes: analyzeErrorCodes(db, options),
            failedModels: analyzeFailedModels(db, options),
            errorMessages: analyzeErrorMessages(db, options),
            providers: analyzeProviderErrors(db, options),
            timeBased: analyzeTimeBasedErrors(db, options),
            combined: analyzeCombinedPatterns(db, options)
        };

        // Close database
        db.close();

        // Output results
        if (options.json) {
            const jsonOutput = formatJsonOutput(analysisResults);

            if (options.export) {
                writeFileSync(options.export, jsonOutput, 'utf-8');
                console.log(`Results exported to ${options.export}`);
            } else {
                console.log(jsonOutput);
            }
        } else {
            printConsoleOutput(analysisResults);

            if (options.export) {
                const jsonOutput = formatJsonOutput(analysisResults);
                writeFileSync(options.export, jsonOutput, 'utf-8');
                console.log(`Results also exported to ${options.export}`);
            }
        }

    } catch (error) {
        console.error('Error running analysis:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run the script
main();
