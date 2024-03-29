const express = require('express');
const router = express.Router(); // Create an Express Router instance
const axios = require('axios');
const fs = require('fs');

module.exports = {
    getToday10AMEST, getToday1130PMEST, getYesterdayEST
};

/**
 * ISO8601 formatted string representing 10 a.m. EST Today, e.g., YYYY-MM-DDTHH:MM:SSZ
 * @returns {String} ISO8601 string for 10 a.m. EST Today
 */
function getToday10AMEST() {
    const today = new Date();
    today.setHours(10, 0, 0); // Set the time to 10:00 AM
    today.setMinutes(today.getMinutes() - today.getTimezoneOffset()); // Adjust for EST
    const utcString = today.toISOString(); // Get the UTC representation of the date
    return utcString.slice(0, 19) + 'Z'
}

/**
 * ISO8601 formatted string representing 11:30 p.m. EST Today, e.g., YYYY-MM-DDTHH:MM:SSZ
 * @returns {String} ISO8601 string for 11:30 p.m. EST Today
 */
function getToday1130PMEST() {
    const today = new Date();
    today.setHours(23, 30, 0); // Set the time to 10:00 AM
    const utcString = today.toISOString(); // Get the UTC representation of the date
    return utcString.slice(0, 19) + 'Z'
}

function getYesterdayEST() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1); // Set date to yesterday
    yesterday.setMinutes(yesterday.getMinutes() - yesterday.getTimezoneOffset()); // Adjust for EST

    const isoString = yesterday.toISOString(); 
    return isoString.slice(0, 10)
}