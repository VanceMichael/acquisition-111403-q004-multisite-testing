export const seed={
  "lot": "L1",
  "parts": [
    {
      "serial": "chip1",
      "head": 1,
      "site": 1,
      "tests": 2
    }
  ]
};
export const seedPath="/summary";
export const routes=[
  {
    "path": "/records",
    "body": {
      "stream": "s1",
      "nextOffset": 5,
      "records": [
        {
          "offset": 0,
          "type": "LOT",
          "lot": "L1"
        },
        {
          "offset": 1,
          "type": "PART_START",
          "head": 1,
          "site": 1
        },
        {
          "offset": 2,
          "type": "PART_START",
          "head": 1,
          "site": 2
        },
        {
          "offset": 3,
          "type": "TEST",
          "head": 1,
          "site": 2,
          "number": 9,
          "value": 12,
          "flags": {
            "valid": true,
            "executed": true,
            "passed": false
          }
        },
        {
          "offset": 4,
          "type": "PART_END",
          "head": 1,
          "site": 1,
          "serial": "chip1"
        }
      ]
    },
    "method": "GET",
    "status": 200,
    "query": {
      "offset": "0"
    },
    "headers": {}
  },
  {
    "path": "/records",
    "body": {
      "stream": "s1",
      "nextOffset": 8,
      "records": [
        {
          "offset": 5,
          "type": "DESCR",
          "lot": "L1",
          "number": 9,
          "unit": "V",
          "scale": -3
        },
        {
          "offset": 6,
          "type": "PART_END",
          "head": 1,
          "site": 2,
          "serial": "chip2"
        },
        {
          "offset": 7,
          "type": "LOT_END",
          "lot": "L1"
        }
      ]
    },
    "method": "GET",
    "status": 200,
    "query": {
      "offset": "5"
    },
    "headers": {}
  }
];
export const phases={
  "interrupted": [
    {
      "path": "/records",
      "body": {
        "stream": "s1",
        "nextOffset": 7,
        "records": [
          {
            "offset": 5,
            "type": "HEAD_END",
            "head": 1
          },
          {
            "offset": 6,
            "type": "LOT_END",
            "lot": "L1"
          }
        ]
      },
      "method": "GET",
      "status": 200,
      "query": {
        "offset": "5"
      },
      "headers": {}
    }
  ],
  "new-lot": [
    {
      "path": "/records",
      "body": {
        "stream": "s1",
        "nextOffset": 9,
        "records": [
          {
            "offset": 5,
            "type": "LOT",
            "lot": "L2"
          },
          {
            "offset": 6,
            "type": "DESCR",
            "lot": "L2",
            "number": 9,
            "unit": "A",
            "scale": 0
          },
          {
            "offset": 7,
            "type": "PART_START",
            "head": 1,
            "site": 2
          },
          {
            "offset": 8,
            "type": "TEST",
            "head": 1,
            "site": 2,
            "number": 9,
            "value": null,
            "flags": {
              "valid": false,
              "executed": false,
              "passed": false
            }
          }
        ]
      },
      "method": "GET",
      "status": 200,
      "query": {
        "offset": "5"
      },
      "headers": {}
    }
  ]
};
export const portalKind="";
