-- ROOK — verify the foreign-jobs cleanup worked
-- Restructured as an array check instead of one giant regex string,
-- which was getting truncated by the SQL editor's input handling.

select count(distinct jobs.id) as remaining_foreign_active_jobs
from jobs, unnest(array[
  'china','india','germany','united kingdom','canada','mexico',
  'brazil','france','japan','australia','singapore','spain','italy',
  'netherlands','switzerland','ireland','poland','sweden','belgium',
  'south korea','taiwan','hong kong','philippines','vietnam',
  'thailand','malaysia','indonesia','south africa','israel','turkey',
  'argentina','colombia','chile','portugal','austria','denmark',
  'norway','finland','czech republic','romania','hungary','greece',
  'new zealand','united arab emirates','saudi arabia','egypt','russia',
  'mumbai','bangalore','bengaluru','delhi','new delhi','hyderabad',
  'pune','chennai','gurgaon','gurugram','noida','kolkata',
  'shanghai','beijing','shenzhen','guangzhou','manila','jakarta',
  'kuala lumpur','bangkok','ho chi minh city','hanoi','seoul',
  'tokyo','osaka','sao paulo','mexico city','dubai','tel aviv'
]) as term
where status = 'active'
  and (job_lng > 0 or location_raw ~* ('\y' || term || '\y'));
