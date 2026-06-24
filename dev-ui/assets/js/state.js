// Global mutable state — shared across all modules
const API = '';  // ponytail: empty = same-origin

let currentDriveId    = null;
let currentDriveLabel = '';
let currentPath       = '/';
let fileView          = 'list';
let authToken         = null;
let currentUsername   = '';
let dirEntries        = [];
let _filtered         = null;
let _sel              = new Set();
let _lastClickIdx     = -1;
