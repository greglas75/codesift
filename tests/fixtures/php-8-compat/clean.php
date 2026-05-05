<?php
// Modernized version of breaking.php — should produce zero findings.

$arr = ['a' => 1, 'b' => 2];
foreach ($arr as $k => $v) {
    echo "$k=$v\n";
}

$double = function ($x) { return $x * 2; };

$f = (float)"3.14";

$display = (new \NumberFormatter('en_US', \NumberFormatter::CURRENCY))->format(1234.56);

$pos = strpos($haystack ?? '', $needle);
$len = strlen($s ?? '');
