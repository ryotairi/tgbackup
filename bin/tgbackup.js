#!/usr/bin/env node
'use strict';

require('../src/cli')
    .main()
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
