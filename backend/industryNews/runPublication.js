'use strict';
require('dotenv').config();
const { SupabaseNewsStore } = require('./store');
const { db } = require('../resources/store');
require('./publication').tick({ store: new SupabaseNewsStore(db()), social: require('./social') })
  .then(result => console.log(JSON.stringify({ state: result.state, published: result.published.map(article => article.slug) }, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
