# Journal
Need a file to keep track of why I chose to so certain things.

## 03-17-2024
Going to try to use balldontlie api when available since its request limits are per minute not per month.

## 03-16-2024
I think I may have done more work than needed. I think the odds endpoint does all the things the games endpoint does. So i dont think i need function to fetch from both. Silverlining the games endpoint doesnt count towards your request quota so i havent been eating into it yet.

## 03-15-2024
Starting with recommendations on over and under lines on NBA games. Looking at APIs that I can use.
* Promising:
    * not sure why yet but when I try to do `await axios.get()` these apis error out for me (api-sports.io didnt) but when i try `get(..).then(...)` this seems to work.
    * [odds-api](https://the-odds-api.com)
        * will probably use this to get games in a given day
    * [balldontlie](https://www.balldontlie.io/#introduction)
        * use this to get score from previous few games
* Looked at but passed on
    * [https://api-sports.io](https://api-sports.io)
        * Found that the documentation wasnt too helpful. In practice returns didnt exacly match the expected from docs. Docs also didnt make it clear when search params where required or not. Ultimately didnt have enough functionality to serve my needs, there seem to be other apis that are better set up and can do what this one does along with other things.