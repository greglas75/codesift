<?php
namespace app\helpers;

class SwitchToMatch
{
    public function classify(string $kind): string
    {
        switch ($kind) {
            case 'a':
                return 'alpha';
            case 'b':
                return 'beta';
            case 'c':
                return 'gamma';
        }
        return 'unknown';
    }
}
