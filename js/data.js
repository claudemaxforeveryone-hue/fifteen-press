// Reference data. Plain script so the engine tests (Node) and the app (browser module) share it.
(function (root) {
  "use strict";

  // Number of 4x4 positions at each optimal solution length 0..80 (single-tile moves).
  // OEIS A089484 (Korf & Schultze 2005 breadth-first search). Sum = 16!/2.
  const DIST4 = [
    1, 2, 4, 10, 24, 54, 107, 212, 446, 946, 1948, 3938, 7808, 15544, 30821,
    60842, 119000, 231844, 447342, 859744, 1637383, 3098270, 5802411, 10783780,
    19826318, 36142146, 65135623, 116238056, 204900019, 357071928, 613926161,
    1042022040, 1742855397, 2873077198, 4660800459, 7439530828, 11668443776,
    17976412262, 27171347953, 40271406380, 58469060820, 83099401368,
    115516106664, 156935291234, 208207973510, 269527755972, 340163141928,
    418170132006, 500252508256, 581813416256, 657076739307, 719872287190,
    763865196269, 784195801886, 777302007562, 742946121222, 683025093505,
    603043436904, 509897148964, 412039723036, 317373604363, 232306415924,
    161303043901, 105730020222, 65450375310, 37942606582, 20696691144,
    10460286822, 4961671731, 2144789574, 868923831, 311901840, 104859366,
    29592634, 7766947, 1508596, 272198, 26638, 3406, 70, 17,
  ];

  // 3x3, lengths 0..31. OEIS A089473. Sum = 9!/2. (The app recomputes this live as a check.)
  const DIST3 = [
    1, 2, 4, 8, 16, 20, 39, 62, 116, 152, 286, 396, 748, 1024, 1893, 2512, 4485,
    5638, 9529, 10878, 16993, 17110, 23952, 20224, 24047, 15578, 14560, 6274,
    3910, 760, 221, 2,
  ];

  const FACTS = [
    "Noyes Chapman, a postmaster in Canastota, New York, built the puzzle in the 1870s. It became a craze in 1880.",
    "Sam Loyd claimed the invention from 1891 until his death. Historians Slocum and Sonneveld found he had nothing to do with it.",
    "Johnson and Story proved in 1879 that half of all arrangements can never be solved. Swapping 14 and 15 is one of them.",
    "Every solvable 4x4 position can be finished in 80 moves or fewer. Only 17 positions need all 80.",
    "There are 10,461,394,944,000 solvable 4x4 positions. A random one needs 52.6 moves on average.",
    "The most common optimal length for a random 4x4 is 53 moves.",
    "Counting a slide of several tiles in a row as one move, no 4x4 position needs more than 43.",
    "Every 3x3 position can be solved in 31 moves. Only 2 of the 181,440 need that many.",
    "Nobody knows the exact worst case for 5x5. It sits somewhere between 152 and 205 moves.",
  ];

  function factorial(n) {
    let f = 1;
    for (let i = 2; i <= n; i++) f *= i;
    return f;
  }

  const api = { DIST4, DIST3, FACTS, factorial };
  root.FifteenData = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
