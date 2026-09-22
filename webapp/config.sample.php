<?php
// Copy this file to config.php (gitignored) and fill in real values.
// config.php is loaded by ingest.php and data.php.

return [
    // shared secret the trader (src/webReport.ts / src/generateWebStats.ts) sends
    // in the "X-Report-Secret" header when pushing data. Keep this out of git.
    'ingestSecret' => 'CHANGE-ME-INGEST-SECRET',

    // password the website itself asks for once, then stores in localStorage.
    // Sent back as the "X-Viewer-Password" header on every data.php request.
    'viewerPassword' => 'CHANGE-ME-VIEWER-PASSWORD',

    // absolute path to the folder the json files are stored/read from
    'dataDir' => __DIR__ . '/data',
];
